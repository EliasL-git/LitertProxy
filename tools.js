// Simple tools registry. Export functions you want the gateway to be able to call.
// Each tool receives an `args` object and should return a Promise<string>.

const os = require('os');

async function get_current_time(args) {
  return new Date().toISOString();
}

async function echo(args) {
  return String(args.input || '');
}

// Example: disabled for safety. If you enable, be aware of command injection risks.
// async function run_shell(args) {
//   const { exec } = require('child_process');
//   return new Promise((resolve, reject) => {
//     exec(String(args.cmd || ''), { timeout: 10000 }, (err, stdout, stderr) => {
//       if (err) return resolve(`ERROR: ${err.message}\n${stderr}`);
//       resolve(stdout || stderr);
//     });
//   });
// }

module.exports = {
  get_current_time,
  echo,
  // run_shell,
};
