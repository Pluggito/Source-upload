const { PrismaClient } = require('../generated/prisma');
const isProd = process.env.NODE_ENV === 'production';

const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['query', 'info', 'warn', 'error'],
});

// Test database connection
prisma.$connect()
  .then(() => {
    console.log('✅ Database connection established');
  })
  .catch((err) => {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  });

module.exports = prisma;