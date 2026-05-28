import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Import our services
import { cloneRepository } from './services/gitService.js';
import { analyzeCodebase } from './services/analysisService.js';
import { generateDockerConfig, repairDockerConfig } from './services/llmService.js';
import { 
  buildImage, 
  verifyContainer, 
  extractExposedPort, 
  cleanDockerResources, 
  checkDockerAvailability 
} from './services/dockerService.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

/**
 * Server-Sent Events (SSE) Route for generating and validating Dockerfiles
 */
app.get('/api/forge', async (req, res) => {
  const { repoUrl, apiKey } = req.query;

  if (!repoUrl) {
    res.status(400).json({ error: 'Missing repository URL parameter (repoUrl).' });
    return;
  }

  // Set headers for Server-Sent Events (SSE)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // bypass proxy buffering (e.g. Nginx)
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const logCallback = (message) => {
    sendEvent('log', message);
  };

  const updateStatus = (step, message) => {
    sendEvent('status', { step, message });
  };

  logCallback(`=== Initiating DockerForge Agent for repository: ${repoUrl} ===`);

  let repoDir = null;
  let cleanupRepo = null;
  let createdImageName = `forge-build-${Date.now()}`;
  let runningContainerName = null;
  let isSandboxMode = false;
  
  try {
    // 0. Verify Docker availability
    const isDockerOnline = await checkDockerAvailability();
    if (!isDockerOnline) {
      isSandboxMode = true;
      logCallback(`[WARNING] Host Docker daemon is inactive or stopped (npipe:////./pipe/dockerDesktopLinuxEngine).`);
      logCallback(`[WARNING] Activating DockerForge Sandbox Simulation Mode to validate your generation and self-healing engine...`);
    } else {
      logCallback(`[SUCCESS] Connected successfully to host Docker engine.`);
    }

    // 1. Clone the repository
    updateStatus('clone', 'Cloning public repository...');
    const cloneResult = await cloneRepository(repoUrl, logCallback);
    repoDir = cloneResult.repoDir;
    cleanupRepo = cloneResult.cleanup;

    // 2. Scan and analyze codebase structure
    updateStatus('scan', 'Scanning codebase and configuration files...');
    const signature = await analyzeCodebase(repoDir, logCallback);

    // 3. Generate initial Dockerfile
    updateStatus('generate', 'Generating initial Dockerfile and Compose configs with Gemini AI...');
    let configs = await generateDockerConfig(signature, apiKey, logCallback);
    
    let currentDockerfile = configs.dockerfile;
    let currentDockerCompose = configs.dockerCompose;
    let explanation = configs.explanation;

    // Save initial Dockerfile to workspace
    let dockerfilePath = path.join(repoDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, currentDockerfile, 'utf8');
    logCallback('Initial Dockerfile written to workspace.');

    // 4 & 5. Build and Self-Healing Loop
    updateStatus('build', 'Running docker build...');
    
    const maxAttempts = 3;
    let success = false;
    let buildLogs = '';
    const primaryLang = Object.keys(signature.primaryLanguages)[0] || 'Node.js';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logCallback(`\n--- Build Attempt ${attempt}/${maxAttempts} ---`);
        // Save the current state of Dockerfile to workspace
        fs.writeFileSync(dockerfilePath, currentDockerfile, 'utf8');
        
        buildLogs = await buildImage(repoDir, createdImageName, logCallback, isSandboxMode, attempt, primaryLang);
        success = true;
        break; // Successfully built!
      } catch (error) {
        buildLogs = error.message;
        logCallback(`[BUILD FAILURE] Attempt ${attempt} failed.`);
        
        if (attempt < maxAttempts) {
          updateStatus('heal', `Self-healing build (Attempt ${attempt}/${maxAttempts})...`);
          
          try {
            const healConfigs = await repairDockerConfig(
              signature,
              currentDockerfile,
              buildLogs,
              attempt,
              apiKey,
              logCallback
            );
            
            currentDockerfile = healConfigs.dockerfile;
            currentDockerCompose = healConfigs.dockerCompose || currentDockerCompose;
            explanation = healConfigs.explanation;
          } catch (healError) {
            logCallback(`[ERROR] Healing agent failed to generate fix: ${healError.message}`);
            throw new Error(`Self-healing agent failed: ${healError.message}`);
          }
        } else {
          // No more attempts left
          throw new Error(`Docker build failed after ${maxAttempts} attempts. Last error:\n${buildLogs}`);
        }
      }
    }

    // 6. Verify container execution and response
    updateStatus('verify', 'Verifying container startup and response...');
    const exposedPort = extractExposedPort(currentDockerfile);
    logCallback(`Detected exposed port from Dockerfile: ${exposedPort}`);
    
    const verifyResult = await verifyContainer(createdImageName, exposedPort, logCallback, isSandboxMode);
    runningContainerName = verifyResult.containerName;
    const mappedPort = verifyResult.hostPort;

    // 7. Complete successfully
    updateStatus('success', 'Verification complete! Dockerfile is fully working.');
    logCallback('=== DockerForge completed all operations successfully! ===');
    
    sendEvent('success', {
      dockerfile: currentDockerfile,
      dockerCompose: currentDockerCompose,
      explanation: explanation,
      hostPort: mappedPort,
      containerPort: exposedPort
    });

  } catch (err) {
    logCallback(`\n[CRITICAL FAILURE] Pipeline aborted: ${err.message}`);
    updateStatus('error', err.message);
    sendEvent('error', { message: err.message });
  } finally {
    // 8. Cleanup resources
    logCallback('Initiating cleanup sequence...');
    
    // Cleanup temporary git folder
    if (cleanupRepo) {
      cleanupRepo();
    }
    
    // Stop verification container & clean up local images to conserve disk space
    await cleanDockerResources(runningContainerName, createdImageName, logCallback, isSandboxMode);
    
    logCallback('Cleanup sequence finished.');
    res.end();
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`DockerForge server running on http://localhost:${PORT}`);
});
