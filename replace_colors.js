const fs = require('fs');
const path = require('path');

const directoryToSearch = path.join(__dirname, 'src', 'app');

function replaceInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // Replace bg-white/[0.0X] with bg-[var(--bg-elevated)]
  content = content.replace(/bg-white\/\[0\.0[0-9]+\]/g, 'bg-[var(--bg-elevated)]');
  
  // Replace hover:text-white with hover:text-[var(--fg)]
  content = content.replace(/hover:text-white/g, 'hover:text-[var(--fg)]');
  
  // Replace text-white (where it means foreground in dark mode, but we want it to adapt)
  // Be careful not to replace text-white inside button.tsx or where it is genuinely needed.
  // We'll replace group-hover:text-white
  content = content.replace(/group-hover:text-white/g, 'group-hover:text-[var(--fg)]');
  
  // Replace border-[var(--color-border)] with border-[var(--border)]
  content = content.replace(/var\(--color-border\)/g, 'var(--border)');
  content = content.replace(/var\(--color-fg-muted\)/g, 'var(--fg-muted)');
  content = content.replace(/var\(--color-fg-subtle\)/g, 'var(--fg-subtle)');
  content = content.replace(/var\(--color-fg\)/g, 'var(--fg)');
  content = content.replace(/var\(--color-accent-soft\)/g, 'var(--accent-soft)');
  content = content.replace(/var\(--color-accent\)/g, 'var(--accent)');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${filePath}`);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath);
    } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      replaceInFile(fullPath);
    }
  }
}

walkDir(directoryToSearch);
console.log('Done replacing colors in src/features.');
