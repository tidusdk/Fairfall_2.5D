const { readFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const packageJsonPath = join(__dirname, '../package.json');

function checkCreatorTypesVersion(version) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmExecutable, ['view', '@cocos/creator-types', 'versions'], {
    shell: true,
  });

  let versions = result.stdout.toString();
  try {
    versions = JSON.parse(versions);
  } catch (error) {
    return false;
  }

  return Array.isArray(versions) && versions.includes(version);
}

try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const creatorTypesVersion = packageJson.devDependencies['@cocos/creator-types'].replace(/^[^\d]+/, '');

  if (!checkCreatorTypesVersion(creatorTypesVersion)) {
    console.log('\u001b[33mWarning:\u001b[0m');
    console.log('  @en');
    console.log('    Version check of @cocos/creator-types failed.');
    console.log(`    The definition of ${creatorTypesVersion} has not been released yet. Please export the definition to the ./node_modules directory by selecting "Developer -> Export Interface Definition" in the Creator editor.`);
    console.log('  @zh');
    console.log('    @cocos/creator-types 版本检查失败。');
    console.log(`    ${creatorTypesVersion} 定义还未发布，请先通过 Creator 编辑器菜单“开发者 -> 导出接口定义”导出定义到 ./node_modules 目录。`);
  }
} catch (error) {
  console.error(error);
}