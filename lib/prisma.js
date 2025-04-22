const { PrismaClient } = require('../generated/prisma');
const isProd = process.env.NODE_ENV === 'production';

const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['query', 'info', 'warn', 'error'],
});
module.exports = prisma;