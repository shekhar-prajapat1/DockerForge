import { spawn, exec } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';

/**
 * Extracts the EXPOSE port from a Dockerfile.
 * @param {string} dockerfileContent - Dockerfile text
 * @returns {number} Exposed port
 */
export function extractExposedPort(dockerfileContent) {
  const match = dockerfileContent.match(/EXPOSE\s+(\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return 8080; // default fallback
}

/**
 * Executes a shell command synchronously and returns the stdout.
 * @param {string} cmd - Command to run
 * @returns {Promise<string>} stdout
 */
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Checks if the host Docker daemon is currently running and accessible.
 * @returns {Promise<boolean>} True if online
 */
export async function checkDockerAvailability() {
  try {
    await execPromise('docker ps');
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Builds the Docker image and streams logs in real-time. Supports Sandbox Simulation fallback.
 * @param {string} repoDir - The cloned repository folder
 * @param {string} imageName - Unique tag to build
 * @param {function} logCallback - Function to stream logs back to client
 * @param {boolean} isSandboxMode - Flag indicating if simulation mode is active
 * @param {number} attempt - Current build attempt count (1, 2, or 3)
 * @param {string} framework - Primary framework/language detected
 * @returns {Promise<string>} Accumulated logs on success
 */
export function buildImage(repoDir, imageName, logCallback, isSandboxMode = false, attempt = 1, framework = 'Node.js') {
  if (isSandboxMode) {
    return new Promise((resolve, reject) => {
      logCallback(`[SANDBOX SIMULATION] Initiating virtual docker build for image: ${imageName}`);
      
      let delay = 100;
      const lines = [
        `Executing: docker build -t ${imageName} .`,
        `#1 [internal] load build context`,
        `#1 transferring context: 3.82MB done`,
        `#2 [1/8] FROM node:20-alpine`,
        `#2 CACHED`,
        `#3 [2/8] RUN apk add --no-cache libc6-compat git`,
        `#3 CACHED`,
        `#4 [3/8] WORKDIR /usr/src/app`,
        `#4 DONE 0.2s`,
        `#5 [4/8] COPY package*.json ./`,
        `#5 DONE 0.4s`,
        `#6 [5/8] RUN npm ci --omit=dev`,
        `#6 DONE 2.1s`,
        `#7 [6/8] COPY . .`,
        `#7 DONE 0.3s`
      ];

      // Stream initial layers
      lines.forEach((line, index) => {
        setTimeout(() => {
          logCallback(line);
        }, delay * index);
      });

      // After initial layers, handle success or simulation failure
      setTimeout(() => {
        if (attempt === 1) {
          // Attempt 1: Inject a realistic compilation/script failure for Gemini to heal
          const failureLogs = [
            `#8 [7/8] RUN npm run build`,
            `#8 1.12 > student-portal@1.0.0 build`,
            `#8 1.12 > next build`,
            `#8 2.45 Error: Cannot find module './components/Navbar' or its corresponding type declarations.`,
            `#8 2.46   import Navbar from '../components/Navbar';`,
            `#8 2.46   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`,
            `#8 2.80 npm ERR! code ELIFECYCLE`,
            `#8 2.81 npm ERR! errno 1`,
            `#8 2.82 npm ERR! student-portal@1.0.0 build: \`next build\``,
            `#8 2.82 npm ERR! Exit status 1`,
            `#8 [ERROR] Docker build failed with exit code 1.`
          ];

          failureLogs.forEach((line, index) => {
            setTimeout(() => {
              logCallback(line);
              if (index === failureLogs.length - 1) {
                reject(new Error(failureLogs.join('\n')));
              }
            }, 150 * index);
          });
        } else {
          // Attempt 2+: Simulate a successful compilation since Gemini repaired the Dockerfile!
          const successLogs = [
            `#8 [7/8] RUN RUN chown -R node:node /usr/src/app`,
            `#8 DONE 0.2s`,
            `#9 [8/8] RUN npm run build`,
            `#9 1.45 > student-portal@1.0.0 build`,
            `#9 1.45 > next build`,
            `#9 5.80   ▲ Next.js 14.1.0`,
            `#9 5.81   - Creating an optimized production build ...`,
            `#9 12.4   - Compiled successfully`,
            `#9 12.5   - Collecting page data ...`,
            `#9 15.2   - First Load JS shared by all: 73.9 kB`,
            `#9 DONE 15.6s`,
            `#10 exporting to image`,
            `#10 exporting layers done`,
            `#10 naming to docker.io/library/${imageName}:latest done`,
            `[SUCCESS] Docker virtual build completed successfully.`
          ];

          successLogs.forEach((line, index) => {
            setTimeout(() => {
              logCallback(line);
              if (index === successLogs.length - 1) {
                resolve(successLogs.join('\n'));
              }
            }, 150 * index);
          });
        }
      }, delay * lines.length);
    });
  }

  // Native execution mode (when Docker daemon is online)
  return new Promise((resolve, reject) => {
    logCallback(`Executing: docker build -t ${imageName} .`);
    
    const child = spawn('docker', ['build', '-t', imageName, '.'], {
      cwd: repoDir,
      shell: true
    });
    
    let accumulatedLogs = '';
    
    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      accumulatedLogs += chunk;
      logCallback(chunk);
    });
    
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      accumulatedLogs += chunk;
      logCallback(chunk);
    });
    
    child.on('error', (err) => {
      logCallback(`[ERROR] Spawn failed: ${err.message}`);
      reject(err);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        logCallback(`[SUCCESS] Docker build completed successfully.`);
        resolve(accumulatedLogs);
      } else {
        logCallback(`[ERROR] Docker build failed with exit code ${code}.`);
        reject(new Error(accumulatedLogs));
      }
    });
  });
}

/**
 * Runs the container, detects host mapped port, pings it, and verifies health. Supports Sandbox Simulation.
 * @param {string} imageName - Built image tag
 * @param {number} containerPort - Exposed port inside container
 * @param {function} logCallback - Function to stream logs back to client
 * @param {boolean} isSandboxMode - Flag indicating if simulation mode is active
 * @returns {Promise<{containerName: string, hostPort: number}>}
 */
export async function verifyContainer(imageName, containerPort, logCallback, isSandboxMode = false) {
  const containerName = `verify-${imageName}`;
  logCallback(`Verifying container run...`);

  if (isSandboxMode) {
    return new Promise((resolve) => {
      setTimeout(() => {
        logCallback(`[SANDBOX SIMULATION] Executing: docker run -d -p 0:${containerPort} --name ${containerName} ${imageName}`);
        logCallback(`[SANDBOX SIMULATION] Container started successfully. ID: v-id-${Date.now().toString().substring(8)}`);
        logCallback(`[SANDBOX SIMULATION] Waiting 3 seconds for application boot...`);
        
        setTimeout(() => {
          const hostPort = 49153 + Math.floor(Math.random() * 100);
          logCallback(`[SANDBOX SIMULATION] Container port ${containerPort} successfully mapped to host port ${hostPort}.`);
          logCallback(`[SANDBOX SIMULATION] Pinging http://localhost:${hostPort}/ to verify responsiveness...`);
          logCallback(`[SANDBOX SIMULATION] Ping attempt 1/3...`);
          logCallback(`[SUCCESS] Port is active and responded successfully!`);
          
          resolve({ containerName, hostPort });
        }, 1500);
      }, 500);
    });
  }
  
  // Clean up any old container with the same name if it exists
  try {
    await execPromise(`docker rm -f ${containerName}`);
  } catch (e) {
    // Ignore if it didn't exist
  }
  
  // Run the container mapping to a random host port
  const runCmd = `docker run -d -p 0:${containerPort} --name ${containerName} ${imageName}`;
  logCallback(`Executing: ${runCmd}`);
  
  try {
    const containerId = await execPromise(runCmd);
    logCallback(`Container started successfully. ID: ${containerId.substring(0, 12)}`);
    
    // Wait 3 seconds for app to initialize inside container
    logCallback(`Waiting 3 seconds for application boot...`);
    await new Promise(r => setTimeout(r, 3000));
    
    // Query host mapped port
    logCallback(`Querying mapped host port...`);
    const portMapping = await execPromise(`docker port ${containerName} ${containerPort}`);
    const portMatch = portMapping.match(/:(\d+)$/);
    if (!portMatch || !portMatch[1]) {
      throw new Error(`Could not resolve host port mapping from: "${portMapping}"`);
    }
    const hostPort = parseInt(portMatch[1], 10);
    logCallback(`Container port ${containerPort} successfully mapped to host port ${hostPort}.`);
    
    // Health check ping (HTTP fetch)
    logCallback(`Pinging http://localhost:${hostPort}/ to verify responsiveness...`);
    let healthChecked = false;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      logCallback(`Ping attempt ${attempt}/3...`);
      try {
        await pingUrl(`http://localhost:${hostPort}/`);
        healthChecked = true;
        logCallback(`[SUCCESS] Port is active and responded successfully!`);
        break;
      } catch (err) {
        logCallback(`[PING WARNING] Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          logCallback('Retrying ping in 2 seconds...');
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    
    if (!healthChecked) {
      logCallback(`[WARNING] HTTP health check failed. Fetching container execution logs...`);
      try {
        const runtimeLogs = await execPromise(`docker logs ${containerName}`);
        logCallback(`\n--- Container Runtime Logs ---\n${runtimeLogs}\n------------------------------\n`);
      } catch (e) {
        logCallback(`Failed to read container logs: ${e.message}`);
      }
      throw new Error(`Application container failed to respond on http://localhost:${hostPort}/`);
    }
    
    return { containerName, hostPort };
  } catch (error) {
    logCallback(`[ERROR] Container execution verification failed: ${error.message}`);
    try {
      const runtimeLogs = await execPromise(`docker logs ${containerName}`);
      logCallback(`\n--- Container Runtime Logs (Failure Dump) ---\n${runtimeLogs}\n------------------------------\n`);
    } catch (e) {
      // Container might not even have started
    }
    throw error;
  }
}

/**
 * Pings an HTTP endpoint.
 * @param {string} urlStr - Target url
 * @returns {Promise<void>}
 */
function pingUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: 3000 }, (res) => {
      resolve();
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

/**
 * Cleans up Docker containers and images created during validation. Supports Sandbox.
 * @param {string} containerName - Container name to remove
 * @param {string} imageName - Image tag to remove
 * @param {function} logCallback - Function to stream logs back to client
 * @param {boolean} isSandboxMode - Flag indicating if simulation mode is active
 */
export async function cleanDockerResources(containerName, imageName, logCallback, isSandboxMode = false) {
  logCallback(`Cleaning up Docker verification resources...`);
  if (isSandboxMode) {
    logCallback(`[SANDBOX SIMULATION] Cleaned up virtual resources successfully.`);
    return;
  }
  if (containerName) {
    try {
      await execPromise(`docker rm -f ${containerName}`);
      logCallback(`Removed verification container ${containerName}.`);
    } catch (e) {
      // Ignore
    }
  }
  if (imageName) {
    try {
      await execPromise(`docker rmi ${imageName}`);
      logCallback(`Removed verification image ${imageName}.`);
    } catch (e) {
      // Ignore
    }
  }
}
