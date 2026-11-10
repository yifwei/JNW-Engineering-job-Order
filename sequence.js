const fs = require('fs/promises');
const path = require('path');

module.exports = (directory) => {
  const file = path.join(directory, '.sequence.json');
  const lock = path.join(directory, '.sequence.lock');
  const read = async () => {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Number.isSafeInteger(data.nextJobOrder) || data.nextJobOrder < 1 || data.nextJobOrder >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid JO counter. Administrator recovery required.');
    }
    return data.nextJobOrder;
  };
  const reserve = async () => {
    await fs.mkdir(directory, { recursive: true });
    const deadline = Date.now() + 15000;
    while (true) {
      try { await fs.mkdir(lock); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('JO counter is busy. Please retry later.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      const number = await read();
      const temporary = path.join(lock, 'next.json');
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ nextJobOrder: number + 1 }));
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, file);
      return number;
    } finally {
      await fs.rm(lock, { recursive: true });
    }
  };
  return { read, reserve };
};
