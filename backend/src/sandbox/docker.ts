import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import crypto from 'crypto';
import stream from 'stream';
// Main function of this file is to execute user code in a Docker container with resource limits and timeouts for security. It supports multiple programming languages by using different Docker images and commands based on the language specified. The code is written to handle input, capture output, and ensure proper cleanup of resources after execution.
// input is passed to the container's stdin, and both stdout and stderr are captured to return the execution result or any errors that occur during execution. The function also handles timeouts by killing the container if it exceeds the specified execution time limit.

const docker = new Docker({ socketPath: '/var/run/docker.sock' }); // this means the Docker daemon must be running on the same host as this code, and the user must have permission to access the Docker socket.
// docker daemon must be running and accessible for this code to work. The user running this code must have permission to access the Docker socket, which is typically the case if they are in the 'docker' group on Linux. This setup allows the code to create and manage Docker containers for executing user-submitted code securely.
// daemon means the background service that manages Docker containers. The Docker socket is a Unix socket file that allows communication with the Docker daemon. By specifying the socket path, this code can send commands to the Docker daemon to create, start, and manage containers for executing code in a sandboxed environment.

const CONFIGS: Record<string, { image: string; cmd: string[]; filename: string }> = {
  python: {
    image: 'python:3.10-alpine',
    cmd: ['python', '/app/code.py'],
    filename: 'code.py'
  },
  javascript: {
    image: 'node:20-alpine',
    cmd: ['node', '/app/code.js'],
    filename: 'code.js'
  },
  cpp: {
    image: 'gcc:12',
    cmd: ['sh', '-c', 'g++ /app/code.cpp -o /app/code.out && /app/code.out'],
    filename: 'code.cpp'
  },
  c: {
    image: 'gcc:12',
    cmd: ['sh', '-c', 'gcc /app/code.c -o /app/code.out && /app/code.out'],
    filename: 'code.c'
  },
  bash: {
    image: 'alpine:3.18',
    cmd: ['sh', '/app/code.sh'],
    filename: 'code.sh'
  }
}; // This configuration object maps supported programming languages to their respective Docker images, execution commands, and expected filename for the code. It allows the executeCode function to determine how to run the submitted code based on the specified language. Each entry includes the Docker image to use, the command to execute the code within the container, and the filename that will be used when writing the code to a temporary file for execution. This setup enables the function to support multiple languages in a flexible and extensible way by simply adding new entries to this configuration object.
// cmd means the command that will be executed inside the Docker container to run the user's code. It typically includes the interpreter or compiler for the specified language, along with the path to the code file that will be mounted into the container. For compiled languages like C and C++, it includes both the compilation step and the execution step in a single command. This allows the function to handle different languages appropriately based on their execution requirements.

export async function executeCode(code: string, language: string, input?: string): Promise<string> {
  const config = CONFIGS[language];
  if (!config) {
    return `Error: Unsupported language ${language}`;
  }

  // Create temp sandbox dir if not exists
  const tempSandboxDir = path.join(process.cwd(), 'temp_sandbox'); // This creates a temporary directory called 'temp_sandbox' in the current working directory of the process. This directory will be used to store the code files that are created for execution in the Docker containers. Each code file will be named with a unique identifier to avoid conflicts and will be mounted into the Docker container for execution. The use of a temporary directory helps to keep the filesystem organized and allows for easy cleanup after execution.
  await fs.mkdir(tempSandboxDir, { recursive: true }); // This line ensures that the 'temp_sandbox' directory exists before attempting to write any code files into it. The 'recursive: true' option allows for the creation of nested directories if needed, but in this case, it simply ensures that the 'temp_sandbox' directory is created if it doesn't already exist. This is important to prevent errors when trying to write code files to a non-existent directory.

  const fileId = crypto.randomUUID();
  const filePath = path.join(tempSandboxDir, `${fileId}_${config.filename}`); // This generates a unique filename for the code file that will be created for execution. It uses the crypto.randomUUID() function to generate a random UUID, which is then combined with the expected filename from the configuration (e.g., 'code.py' for Python) to create a unique file path. This ensures that each code execution gets its own separate file, preventing conflicts and allowing for concurrent executions without overwriting each other's code files.
  
  try {
    await fs.writeFile(filePath, code); // This writes the user-submitted code to the temporary file that was created with a unique name. The code is saved to the filesystem so that it can be mounted into the Docker container for execution. This step is crucial because the Docker container will read the code from this file when it runs, allowing the user's code to be executed in a sandboxed environment. After writing the code to the file, the function proceeds to run it in the Docker container using the runInDocker function.

    const result = await runInDocker(config.image, config.cmd, filePath, config.filename, input, 2000); // result contains the output of the code execution, including both stdout and stderr. The runInDocker function is called with the appropriate Docker image, command, file path, filename, input, and a timeout of 2000 milliseconds (2 seconds). This function handles the actual execution of the code in the Docker container and returns the result or any errors that occur during execution. The result is then returned by the executeCode function to be sent back to the user or caller.
    return result;
  } catch (error: any) {
    if (error.killed) {
      return (error.stdout || '') + '\n[Error] Execution timed out (2000ms).';
    }
    return (error.stdout || '') + (error.stderr || error.message || 'Unknown execution error');
  } finally {
    if (filePath) {
      try {
        await fs.unlink(filePath); // This line attempts to delete the temporary code file after execution, regardless of whether the execution was successful or if an error occurred. The use of 'finally' ensures that this cleanup step is always executed, preventing leftover files from accumulating in the 'temp_sandbox' directory. If there is an error during the deletion process, it is caught and ignored to avoid interfering with the main execution flow or error handling of the function. This helps maintain a clean filesystem and ensures that temporary files do not persist longer than necessary.
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
} // This function is the main entry point for executing user-submitted code. It takes the code as a string, the programming language, and optional input for the code. It first checks if the specified language is supported by looking it up in the CONFIGS object. If the language is not supported, it returns an error message. If it is supported, it creates a temporary file to store the code, writes the code to that file, and then calls the runInDocker function to execute the code in a Docker container with the appropriate configuration. The function handles any errors that occur during execution, including timeouts, and ensures that temporary files are cleaned up afterward. The result of the execution or any error messages are returned as a string.

function runInDocker(
  image: string,
  cmd: string[],
  hostFilePath: string,
  containerFileName: string,
  input: string | undefined, // input is the data that will be passed to the code running inside the Docker container. It is optional and can be undefined if no input is needed. If provided, this input will be written to the container's stdin stream, allowing the executed code to read it as if it were user input. This is useful for running code that expects input from the user or from another source, enabling more interactive or dynamic code execution within the container.
  timeoutMs: number
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let container: Docker.Container | null = null;
    let isFinished = false;
    let stdoutData = '';
    let stderrData = '';
    // promise means that this function will perform asynchronous operations and will eventually either resolve with a result or reject with an error. The function is designed to execute code in a Docker container, and it uses the Promise to handle the asynchronous nature of container creation, execution, and cleanup. The caller of this function can use .then() and .catch() to handle the resolved output or any errors that occur during the execution process. This allows for clean and manageable asynchronous code when working with Docker containers for code execution. why we are using promise here is because the operations involved in creating, starting, and managing Docker containers are asynchronous, and we need to ensure that we can handle the results or errors properly once those operations complete. By returning a Promise, we can use async/await syntax when calling this function, making it easier to read and maintain while still effectively managing the asynchronous nature of Docker interactions. asynchronous means that the function will not block the execution of other code while it is waiting for the Docker operations to complete. Instead, it will allow other code to run concurrently, and once the Docker operations are finished, it will either resolve with the output or reject with an error, allowing for efficient handling of multiple code executions without blocking the main thread of execution.
    try {
      container = await docker.createContainer({
        Image: image,
        Cmd: cmd,
        HostConfig: {
          Binds: [`${hostFilePath}:/app/${containerFileName}:ro`],
          Memory: 100 * 1024 * 1024, // 100MB
          NanoCpus: 500000000, // 0.5 CPU
          PidsLimit: 50,
          NetworkMode: 'none'
        },
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: true,
        StdinOnce: true,
        Tty: false
      }); // This block of code creates a new Docker container using the specified image and command. It also sets up the host configuration to bind the temporary code file into the container at a specific path, with read-only access. Resource limits are applied to restrict memory usage, CPU usage, and the number of processes that can be spawned within the container. The container is configured to attach to stdin, stdout, and stderr, allowing for input to be passed in and output to be captured. The Tty option is set to false to disable pseudo-terminal allocation, which is appropriate for non-interactive execution of code. This setup ensures that the code runs in a controlled environment with limited resources and no network access for security reasons.

      const execStream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true
      }); // This line attaches to the container's input and output streams, allowing the code to send input to the container's stdin and capture output from stdout and stderr. By setting stream: true, it enables real-time streaming of data between the host and the container. This is essential for passing input to the code running inside the container and for capturing the output as it is produced, which is important for providing feedback to the user or caller about the execution results. The attached streams will be used later in the function to write input to the container and to listen for output data as it is generated during execution. we are attaching to the container's streams so that we can interact with the code running inside the container. This allows us to send input to the code and capture its output, which is crucial for executing user-submitted code and providing feedback on its execution. By attaching to these streams, we can effectively manage the execution process and handle any input or output that occurs during the execution of the code in the Docker container. In short, exec streams allow us to communicate with the code running inside the container, enabling us to pass input and capture output in real-time, which is essential for the functionality of this code execution system.

      // Pass input
      if (input) {
        execStream.write(input); // This line writes the provided input to the container's stdin stream. If the input is defined (not undefined or empty), it will be sent to the code running inside the Docker container as if it were user input. This allows the executed code to read from stdin and process the input accordingly, enabling more interactive or dynamic code execution based on user-provided data. By writing to the execStream, we can effectively pass input to the code running in the container, which is essential for executing code that requires user input or data from an external source.
      }

      // Capture stdout and stderr
      execStream.on('data', (chunk: Buffer) => {
        if (chunk.length > 8) {
          stdoutData += chunk.slice(8).toString('utf8');
        } else {
          stdoutData += chunk.toString('utf8');
        }
      }); // This event listener captures data from the container's stdout stream. The Docker API prefixes each chunk of output with an 8-byte header that indicates the stream type (stdout or stderr) and the size of the chunk. By slicing off the first 8 bytes, we can extract the actual output data and convert it to a UTF-8 string. This allows us to accumulate the standard output produced by the code running inside the container, which can then be returned to the user or caller once execution is complete. The check for chunk length ensures that we only attempt to slice off the header if there is enough data in the chunk, preventing errors when processing smaller chunks of output.

      execStream.on('error', (err) => {
        stderrData += err.message; // This event listener captures any errors that occur while reading from the container's output streams. If an error occurs, it appends the error message to the stderrData variable, which accumulates any error messages produced during execution. This allows us to capture and return any errors that occur while trying to read the output from the container, providing valuable feedback about issues that may arise during code execution. By handling errors in this way, we can ensure that we provide informative error messages to the user or caller when something goes wrong during the execution process.
      });

      await container.start(); // This line starts the Docker container, which begins the execution of the code that has been set up in the container. Once the container is started, the code will run according to the specified command and configuration. This is a crucial step in the process, as it triggers the actual execution of the user-submitted code within the sandboxed environment of the Docker container. After starting the container, we can then wait for it to finish executing and capture the output or any errors that occur during execution.

      let timeoutHandle: NodeJS.Timeout; // This variable will hold the reference to the timeout that is set to enforce the execution time limit for the code running inside the Docker container. By using a timeout, we can ensure that if the code takes too long to execute (exceeding the specified timeoutMs), we can kill the container to prevent it from running indefinitely. This is an important security measure to protect against infinite loops or long-running processes that could consume resources and affect the stability of the system. The timeout will be cleared if the container finishes executing before the timeout is reached, ensuring that we only kill the container if it truly exceeds the allowed execution time.

      const waitPromise = container.wait(); // This line creates a promise that will resolve when the Docker container finishes executing. The container.wait() function returns a promise that resolves with the container's exit status once it has completed its execution. By awaiting this promise, we can effectively wait for the code running inside the container to finish before proceeding to capture the output and return the result. This allows us to manage the asynchronous nature of container execution and ensure that we only attempt to read the output after the code has completed its execution, providing accurate results to the user or caller.

      timeoutHandle = setTimeout(async () => {
        if (!isFinished && container) {
          isFinished = true;
          try {
            await container.kill();
          } catch (e) {}
          reject({ killed: true, stdout: stdoutData, stderr: stderrData });
        }
      }, timeoutMs); // This block sets a timeout to enforce the execution time limit for the code running inside the Docker container. If the container does not finish executing within the specified timeoutMs, this function will be called. It checks if the execution is not already finished and if the container exists, then it sets isFinished to true to prevent further processing, attempts to kill the container to stop its execution, and rejects the promise with an object indicating that the execution was killed due to a timeout, along with any captured stdout and stderr data up to that point. This mechanism ensures that we can safely terminate long-running or potentially infinite code executions, protecting system resources and providing feedback about the timeout event.

      await waitPromise; // This line waits for the Docker container to finish executing. The waitPromise will resolve when the container has completed its execution, allowing us to proceed with capturing the output and returning the result. By awaiting this promise, we can ensure that we only attempt to read the output after the code has finished running, providing accurate results to the user or caller. This is an essential part of managing the asynchronous nature of container execution and ensuring that we handle the results correctly once execution is complete.
      clearTimeout(timeoutHandle); // This line clears the timeout that was set to enforce the execution time limit. If the container finishes executing before the timeout is reached, we want to clear the timeout to prevent it from firing and attempting to kill the container unnecessarily. By clearing the timeout, we ensure that we only kill the container if it truly exceeds the allowed execution time, allowing for normal completion of code execution without interference from the timeout mechanism.

      if (!isFinished) {
        isFinished = true;
        resolve(stdoutData + (stderrData || '')); // This line resolves the promise with the combined output of stdout and stderr once the container has finished executing. If there is any stderr data, it will be appended to the stdout data; otherwise, only stdout will be returned. This allows us to provide the complete output of the code execution, including any error messages that may have been produced, giving the user or caller a comprehensive view of the execution results. By resolving the promise at this point, we can return the output to the caller in a structured way after ensuring that all execution has completed successfully.
      }

    } catch (err: any) {
      if (!isFinished) {
        isFinished = true;
        reject({ killed: false, stdout: stdoutData, stderr: stderrData, message: err.message });
      } // This catch block handles any errors that occur during the process of creating, starting, or managing the Docker container. If an error occurs and the execution is not already marked as finished, it sets isFinished to true to prevent further processing and rejects the promise with an object containing details about the error, including whether the execution was killed due to a timeout, any captured stdout and stderr data up to that point, and the error message. This allows us to provide informative feedback about any issues that arise during the execution process, helping users or callers understand what went wrong and allowing for better debugging and error handling in their code submissions.
    } finally {
      if (container) {
        try {
          await container.remove({ force: true }); // This line attempts to remove the Docker container after execution, regardless of whether it finished successfully or if an error occurred. The 'force: true' option ensures that the container is removed even if it is still running or if there are any issues with stopping it. This cleanup step is crucial to prevent leftover containers from consuming resources and to maintain a clean environment for future code executions. If there is an error during the removal process, it is caught and ignored to avoid interfering with the main execution flow or error handling of the function. This helps ensure that we do not leave behind any containers that could affect system performance or stability.
        } catch (e) {}
      }
    }
  });
}
