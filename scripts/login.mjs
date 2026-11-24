// GitHub device login for free-pi, print-only. Run it when the token file is
// missing or expired; it writes ~/.freepi-plugin/token exactly like the omp
// extension does, so both hosts share one login.
//
//   node scripts/login.mjs

import { deviceLogin } from "../src/token.ts";

const token = await deviceLogin({
  onDeviceCode: ({ userCode, verificationUri }) => {
    const url = userCode ? `${verificationUri}?user_code=${encodeURIComponent(userCode)}` : verificationUri;
    process.stdout.write(`Open ${url}\nCode: ${userCode}\nWaiting for GitHub…\n`);
  },
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
process.stdout.write(`Logged in to free-pi (token ${token.slice(0, 8)}…).\n`);
