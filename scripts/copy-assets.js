const fs = require('fs');
const path = require('path');

const SRC = 'src';
const OUT = 'lib';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const assets = walk(SRC).filter(
  file => !file.endsWith('.ts') && !file.includes('.DS_Store'),
);
for (const file of assets) {
  const target = path.join(OUT, path.relative(SRC, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
}

// 编译产物引用的资源必须真实存在，否则插件加载即报 Cannot find module
const missing = [];
for (const file of walk(OUT).filter(f => f.endsWith('.js'))) {
  const code = fs.readFileSync(file, 'utf8');
  for (const [, ref] of code.matchAll(
    /require\(["'](\.{1,2}\/[^"']+)["']\)/g,
  )) {
    if (!/\.(json|yml|yaml)$/.test(ref)) continue;
    const resolved = path.resolve(path.dirname(file), ref);
    if (!fs.existsSync(resolved)) {
      missing.push(`${path.relative(OUT, file)} -> ${ref}`);
    }
  }
}

if (missing.length) {
  console.error('资源缺失：');
  missing.forEach(item => console.error('  ' + item));
  process.exit(1);
}

console.log(`资源复制完成，共 ${assets.length} 个文件`);
