import * as fs from 'fs';
import * as path from 'path';

const logPath = path.join(__dirname, 'execution_requests.log');

console.clear();
console.log("================================================================================");
console.log("             WATCHING EXECUTION LOGS LIVE: execution_requests.log              ");
console.log("================================================================================\n");

// Ensure log file exists
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, '', 'utf8');
}

// Track file cursor position
let position = fs.statSync(logPath).size;

// Watch for file updates
fs.watch(logPath, (eventType) => {
  if (eventType === 'change') {
    try {
      const stats = fs.statSync(logPath);
      const newSize = stats.size;
      
      if (newSize < position) {
        // File was truncated or reset
        position = 0;
      }
      
      if (newSize > position) {
        const fd = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(newSize - position);
        fs.readSync(fd, buffer, 0, newSize - position, position);
        fs.closeSync(fd);
        
        // Print only the newly added log entries to stdout
        process.stdout.write(buffer.toString('utf8'));
        position = newSize;
      }
    } catch (err: any) {
      console.error("Error reading file updates:", err.message);
    }
  }
});
