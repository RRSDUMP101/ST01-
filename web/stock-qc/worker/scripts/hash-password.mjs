// Prints the bcrypt hash (cost 12) of a password for ADMIN_PASSWORD_HASH – the password itself is never printed or saved.
//   node scripts/hash-password.mjs | npx wrangler secret put ADMIN_PASSWORD_HASH
// Reads the password from stdin (typed without echo on a terminal, or piped). 12–72 UTF-8 bytes, like Sales Office.
import bcrypt from 'bcryptjs';

async function readPassword() {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write('รหัสผ่านเจ้าของระบบ (ไม่แสดงบนจอ): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    stdin.on('data', (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stderr.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  process.stderr.write('รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษรและไม่เกิน 72 bytes\n');
  process.exit(1);
}
process.stdout.write(await bcrypt.hash(password, 12));
