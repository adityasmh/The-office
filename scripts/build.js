const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'vendor', 'agent-office', 'packages', 'ui', 'public', 'assets');
const destDir = path.join(__dirname, '..', 'public', 'assets');

function copyRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log('copied', srcPath, '->', destPath);
    }
  }
}

if (!fs.existsSync(srcDir)) {
  console.error('Upstream assets not found at', srcDir);
  process.exit(1);
}

copyRecursive(srcDir, destDir);
console.log('AgentOffice assets staged in', destDir);
