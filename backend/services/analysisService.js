import fs from 'fs';
import path from 'path';

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  'out',
  '.cache'
]);

const KEY_CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'tsconfig.json',
  'angular.json',
  'vite.config.js',
  'vite.config.ts',
  'next.config.js',
  'next.config.mjs'
];

/**
 * Scans the codebase to construct a signature for LLM consumption.
 * @param {string} dirPath - Path to cloned repository
 * @param {function} logCallback - Function to stream logs back to client
 * @returns {Promise<object>} Codebase signature
 */
export async function analyzeCodebase(dirPath, logCallback) {
  logCallback('Analyzing codebase file structure...');
  
  const fileList = [];
  const extensionCounts = {};
  const foundConfigs = {};
  
  function walkDir(currentPath, depth = 0) {
    if (depth > 5) return; // limit depth to avoid deep nesting
    
    const items = fs.readdirSync(currentPath);
    for (const item of items) {
      if (EXCLUDE_DIRS.has(item)) continue;
      
      const fullPath = path.join(currentPath, item);
      const relativePath = path.relative(dirPath, fullPath);
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (e) {
        continue; // ignore broken symlinks
      }
      
      if (stats.isDirectory()) {
        fileList.push({ type: 'dir', path: relativePath, depth });
        walkDir(fullPath, depth + 1);
      } else if (stats.isFile()) {
        fileList.push({ type: 'file', path: relativePath, size: stats.size, depth });
        
        // Count extensions
        const ext = path.extname(item).toLowerCase();
        if (ext) {
          extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
        } else {
          extensionCounts['no-extension'] = (extensionCounts['no-extension'] || 0) + 1;
        }
        
        // Check for key configs
        const lowerItem = item.toLowerCase();
        if (KEY_CONFIG_FILES.map(f => f.toLowerCase()).includes(lowerItem)) {
          try {
            // Only read files up to 50KB to prevent context bloat
            if (stats.size < 50000) {
              foundConfigs[item] = fs.readFileSync(fullPath, 'utf8');
            } else {
              foundConfigs[item] = `[File too large to read: ${(stats.size / 1024).toFixed(1)} KB]`;
            }
          } catch (err) {
            foundConfigs[item] = `[Error reading file: ${err.message}]`;
          }
        }
      }
    }
  }

  try {
    walkDir(dirPath);
    
    // Sort extension counts
    const primaryLanguages = Object.entries(extensionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .reduce((obj, [key, val]) => {
        obj[key] = val;
        return obj;
      }, {});

    const fileTree = fileList
      .filter(f => f.depth <= 2) // keep structural tree summary clean
      .map(f => `${'  '.repeat(f.depth)}- ${f.path} (${f.type})`)
      .join('\n');

    logCallback(`Codebase analysis completed. Primary file types detected: ${Object.keys(primaryLanguages).join(', ') || 'None'}`);

    return {
      treeSummary: fileTree,
      keyConfigs: foundConfigs,
      primaryLanguages,
      hasExistingDockerfile: fs.existsSync(path.join(dirPath, 'Dockerfile')),
      hasExistingDockerCompose: fs.existsSync(path.join(dirPath, 'docker-compose.yml')) || fs.existsSync(path.join(dirPath, 'docker-compose.yaml'))
    };
  } catch (error) {
    logCallback(`[ERROR] Codebase scan failed: ${error.message}`);
    throw error;
  }
}
