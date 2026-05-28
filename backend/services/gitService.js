import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = path.join(__dirname, '..', 'temp');

// Ensure root temp directory exists
if (!fs.existsSync(TEMP_ROOT)) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
}

/**
 * Clones a public git repository to a unique folder.
 * @param {string} repoUrl - The public Git repo URL
 * @param {function} logCallback - Function to stream logs back to client
 * @returns {Promise<{repoDir: string, cleanup: function}>}
 */
export async function cloneRepository(repoUrl, logCallback) {
  const uniqueName = `repo-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const repoDir = path.join(TEMP_ROOT, uniqueName);

  logCallback(`Cloning repository: ${repoUrl}`);
  
  try {
    const git = simpleGit();
    await git.clone(repoUrl, repoDir, ['--depth', '1']);
    logCallback(`Successfully cloned repository to temporary workspace.`);
    
    const cleanup = () => {
      if (fs.existsSync(repoDir)) {
        try {
          fs.rmSync(repoDir, { recursive: true, force: true });
          logCallback(`Cleaned up temporary workspace.`);
        } catch (err) {
          console.error(`Failed to clean up ${repoDir}:`, err);
        }
      }
    };

    return { repoDir, cleanup };
  } catch (error) {
    logCallback(`[ERROR] Git clone failed: ${error.message}`);
    throw error;
  }
}
