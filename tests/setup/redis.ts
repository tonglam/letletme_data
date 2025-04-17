import Redis from 'ioredis';

// Create Redis client for testing with hardcoded credentials
export const testRedisClient = new Redis({
  host: '118.194.234.17',
  port: 6379,
  password: 'letletguanlaoshiRedis1414',
  db: 0,
  keyPrefix: 'test:',
});
