import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import crypto from 'crypto';

export async function executeCode(code: string, language: string, input?: string): Promise<string> {
  const tempDir = os.tmpdir();
  const fileId = crypto.randomUUID();
  
  let filePath = '';
  let command = '';

  try {
    if (language === 'python') {
      filePath = path.join(tempDir, `${fileId}.py`);
      await fs.writeFile(filePath, code);
      // Use python3 (standard on Mac/Linux)
      command = `python3 ${filePath}`;
    } else if (language === 'javascript') {
      filePath = path.join(tempDir, `${fileId}.js`);
      await fs.writeFile(filePath, code);
      command = `node ${filePath}`;
    } else if (language === 'cpp') {
      filePath = path.join(tempDir, `${fileId}.cpp`);
      const exePath = path.join(tempDir, `${fileId}.out`);
      await fs.writeFile(filePath, code);
      // Compile and then run
      command = `g++ ${filePath} -o ${exePath} && ${exePath}`;
    } else if (language === 'c') {
      filePath = path.join(tempDir, `${fileId}.c`);
      const exePath = path.join(tempDir, `${fileId}.out`);
      await fs.writeFile(filePath, code);
      // Compile with gcc and then run
      command = `gcc ${filePath} -o ${exePath} && ${exePath}`;
    } else if (language === 'bash') {
      filePath = path.join(tempDir, `${fileId}.sh`);
      await fs.writeFile(filePath, code);
      command = `bash ${filePath}`;
    } else {
      return `Error: Unsupported language ${language}`;
    }

    // Execute locally with a 2000ms timeout, piping stdin if provided
    const result = await runWithStdin(command, input, 2000);
    return result;
  } catch (error: any) {
    // Check if the process was killed due to the timeout
    if (error.killed && error.signal === 'SIGTERM') {
      return (error.stdout || '') + '\n[Error] Execution timed out (2000ms).';
    }
    return (error.stdout || '') + (error.stderr || error.message || 'Unknown execution error');
  } finally {
    // Always clean up the temporary file
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Spawns a shell command, writes optional stdin, and collects output with a timeout.
 */
function runWithStdin(command: string, input: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, timeout: timeoutMs });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === null) {
        // Process was killed (e.g. timeout)
        reject({ killed: true, signal: 'SIGTERM', stdout, stderr });
      } else {
        resolve(stdout + (stderr || ''));
      }
    });

    child.on('error', (err) => {
      reject({ killed: false, stdout, stderr, message: err.message });
    });

    // Write stdin input and close the stream
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
