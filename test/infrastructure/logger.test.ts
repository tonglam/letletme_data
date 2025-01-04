import {
  getApiLogger,
  getFplApiLogger,
  getQueueLogger,
  getWorkflowLogger,
} from '../../src/infrastructure/logger';

describe('Logger Infrastructure Tests', () => {
  describe('Logger Creation', () => {
    it('should create logger instances', () => {
      const apiLogger = getApiLogger();
      const fplLogger = getFplApiLogger();
      const queueLogger = getQueueLogger();
      const workflowLogger = getWorkflowLogger();

      // Check if loggers have the expected pino logger methods
      expect(typeof apiLogger.info).toBe('function');
      expect(typeof fplLogger.info).toBe('function');
      expect(typeof queueLogger.info).toBe('function');
      expect(typeof workflowLogger.info).toBe('function');
    });

    it('should return the same instance for multiple calls', () => {
      const firstApiLogger = getApiLogger();
      const secondApiLogger = getApiLogger();
      const firstFplLogger = getFplApiLogger();
      const secondFplLogger = getFplApiLogger();

      expect(firstApiLogger).toBe(secondApiLogger);
      expect(firstFplLogger).toBe(secondFplLogger);
    });
  });

  describe('Logger Properties', () => {
    it('should have correct logging methods', () => {
      const logger = getApiLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should have unique instances for different logger types', () => {
      const apiLogger = getApiLogger();
      const fplLogger = getFplApiLogger();
      const queueLogger = getQueueLogger();
      const workflowLogger = getWorkflowLogger();

      expect(apiLogger).not.toBe(fplLogger);
      expect(apiLogger).not.toBe(queueLogger);
      expect(apiLogger).not.toBe(workflowLogger);
      expect(fplLogger).not.toBe(queueLogger);
      expect(fplLogger).not.toBe(workflowLogger);
      expect(queueLogger).not.toBe(workflowLogger);
    });
  });

  describe('Logger Functionality', () => {
    it('should log messages without throwing errors', () => {
      const logger = getApiLogger();

      expect(() => {
        logger.info('Test info message');
        logger.error('Test error message');
        logger.warn('Test warning message');
        logger.debug('Test debug message');
      }).not.toThrow();
    });

    it('should handle objects in log messages', () => {
      const logger = getApiLogger();
      const testObject = { key: 'value', nested: { prop: 'test' } };

      expect(() => {
        logger.info({ data: testObject }, 'Test message with object');
        logger.error(
          { error: new Error('Test error'), data: testObject },
          'Test error with object',
        );
      }).not.toThrow();
    });
  });

  describe('Logger Configuration', () => {
    it('should have expected logger properties', () => {
      const logger = getApiLogger();

      expect(logger).toHaveProperty('level');
      expect(logger).toHaveProperty('version');
    });

    it('should handle child loggers', () => {
      const parentLogger = getApiLogger();
      const childLogger = parentLogger.child({ module: 'test' });

      expect(typeof childLogger.info).toBe('function');
      expect(() => {
        childLogger.info('Test child logger message');
      }).not.toThrow();
    });
  });
});
