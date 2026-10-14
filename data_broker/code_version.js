// data_broker/code_version.js
// NEU-142: versao de cada peca = hash curto do proprio codigo. Zero passo manual (a imagem
// Docker nao tem o .git). CRLF -> LF: o checkout no Windows (autocrlf) e o do Mac/Docker dao
// o mesmo hash. O mesmo algoritmo existe em Python (eeg_acquisition/ e gesture_detector/).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashFiles(baseDir, relPaths) {
  const h = crypto.createHash('sha256');
  const rels = [...relPaths].map((p) => p.split(path.sep).join('/')).sort();
  for (const rel of rels) {
    const content = fs.readFileSync(path.join(baseDir, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\n${content}\n`, 'utf8');
  }
  return h.digest('hex').slice(0, 7);
}

function brokerFiles(baseDir) {
  const top = fs.readdirSync(baseDir).filter((f) => f.endsWith('.js') && fs.statSync(path.join(baseDir, f)).isFile());
  const publicDir = path.join(baseDir, 'public');
  const pub = fs.existsSync(publicDir)
    ? fs.readdirSync(publicDir).filter((f) => fs.statSync(path.join(publicDir, f)).isFile()).map((f) => `public/${f}`)
    : [];
  return [...top, ...pub];
}

function brokerCodeVersion(baseDir = __dirname) {
  return hashFiles(baseDir, brokerFiles(baseDir));
}

module.exports = { hashFiles, brokerCodeVersion };
