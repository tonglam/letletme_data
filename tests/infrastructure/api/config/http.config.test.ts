import {
  HTTP_CONFIG,
  HTTPErrorCode,
  HTTPTimeout,
} from '../../../../src/infrastructure/api/config/http.config';

describe('HTTP Configuration', () => {
  describe('Timeouts', () => {
    it('should have correct default timeout', () => {
      expect(HTTP_CONFIG.TIMEOUT.DEFAULT).toBe(30_000);
    });

    it('should have correct long timeout', () => {
      expect(HTTP_CONFIG.TIMEOUT.LONG).toBe(60_000);
    });

    it('should have correct short timeout', () => {
      expect(HTTP_CONFIG.TIMEOUT.SHORT).toBe(5_000);
    });
  });

  describe('Retry Configuration', () => {
    it('should have correct retry attempts', () => {
      expect(HTTP_CONFIG.RETRY.DEFAULT_ATTEMPTS).toBe(3);
      expect(HTTP_CONFIG.RETRY.MAX_ATTEMPTS).toBe(5);
    });

    it('should have correct retry delays', () => {
      expect(HTTP_CONFIG.RETRY.BASE_DELAY).toBe(1_000);
      expect(HTTP_CONFIG.RETRY.MAX_DELAY).toBe(10_000);
      expect(HTTP_CONFIG.RETRY.JITTER_MAX).toBe(100);
    });
  });

  describe('Cache Configuration', () => {
    it('should have correct cache timestamp parameter', () => {
      expect(HTTP_CONFIG.CACHE.TIMESTAMP_PARAM).toBe('_t');
    });
  });

  describe('Status Code Ranges', () => {
    it('should have correct success status code range', () => {
      expect(HTTP_CONFIG.STATUS.OK_MIN).toBe(200);
      expect(HTTP_CONFIG.STATUS.OK_MAX).toBe(299);
    });

    it('should have correct client error status code range', () => {
      expect(HTTP_CONFIG.STATUS.CLIENT_ERROR_MIN).toBe(400);
      expect(HTTP_CONFIG.STATUS.CLIENT_ERROR_MAX).toBe(499);
    });

    it('should have correct server error status code range', () => {
      expect(HTTP_CONFIG.STATUS.SERVER_ERROR_MIN).toBe(500);
      expect(HTTP_CONFIG.STATUS.SERVER_ERROR_MAX).toBe(599);
    });
  });

  describe('Default Headers', () => {
    it('should have correct default headers', () => {
      expect(HTTP_CONFIG.HEADERS).toEqual({
        DEFAULT_USER_AGENT: expect.any(String),
        ACCEPT: 'application/json',
        CACHE_CONTROL: 'no-cache, no-store, must-revalidate',
        PRAGMA: 'no-cache',
        EXPIRES: '0',
      });
    });
  });

  describe('Error Codes', () => {
    it('should have correct error codes', () => {
      expect(HTTP_CONFIG.ERROR).toEqual({
        INVALID_REQUEST: 'INVALID_REQUEST',
        UNKNOWN_ERROR: 'UNKNOWN_ERROR',
        INTERNAL_ERROR: 'INTERNAL_ERROR',
        RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
      });
    });
  });

  describe('Type Safety', () => {
    it('should have HTTPTimeout type matching TIMEOUT keys', () => {
      const timeoutKeys: HTTPTimeout[] = ['DEFAULT', 'LONG', 'SHORT'];
      timeoutKeys.forEach((key) => {
        expect(HTTP_CONFIG.TIMEOUT[key]).toBeDefined();
      });
    });

    it('should have HTTPErrorCode type matching ERROR values', () => {
      const errorCodes: HTTPErrorCode[] = [
        'INVALID_REQUEST',
        'UNKNOWN_ERROR',
        'INTERNAL_ERROR',
        'RETRY_EXHAUSTED',
      ];
      errorCodes.forEach((code) => {
        expect(Object.values(HTTP_CONFIG.ERROR)).toContain(code);
      });
    });
  });
});
