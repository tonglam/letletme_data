import axios, {
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import * as E from 'fp-ts/Either';
import { APIError, HTTPClient } from '../../../../src/infrastructure/api/common/client';
import { HTTP_CONFIG } from '../../../../src/infrastructure/api/config/http.config';

// Mock axios
jest.mock('axios');

const mockRequest = jest.fn();
const mockRequestUse = jest.fn();
const mockResponseUse = jest.fn();

// Setup mock implementation
const mockAxiosInstance = {
  request: mockRequest,
  interceptors: {
    request: { use: mockRequestUse },
    response: { use: mockResponseUse },
  },
  defaults: {
    headers: new AxiosHeaders(),
  },
} as unknown as AxiosInstance;

describe('HTTPClient', () => {
  let client: HTTPClient;

  beforeEach(() => {
    jest.clearAllMocks();
    (axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);
    client = new HTTPClient({
      baseURL: 'https://api.example.com',
    });
  });

  describe('Configuration', () => {
    it('should use default configuration when not provided', () => {
      const defaultConfig = {
        baseURL: 'https://api.example.com',
        timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
        validateStatus: expect.any(Function),
      };

      expect(axios.create).toHaveBeenCalledWith(expect.objectContaining(defaultConfig));
    });

    it('should override default configuration with provided values', () => {
      jest.clearAllMocks();
      const customConfig = {
        baseURL: 'https://custom.api.com',
        timeout: 5000,
        headers: { 'Custom-Header': 'value' },
      };

      new HTTPClient(customConfig);

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://custom.api.com',
          timeout: 5000,
          headers: expect.objectContaining({
            'Custom-Header': 'value',
          }),
        }),
      );
    });
  });

  describe('GET requests', () => {
    const mockHeaders = new AxiosHeaders();
    const mockConfig: InternalAxiosRequestConfig = {
      headers: mockHeaders,
      baseURL: 'https://api.example.com',
      url: '/test',
      method: 'GET',
      transformRequest: [],
      transformResponse: [],
      timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      maxContentLength: -1,
      maxBodyLength: -1,
      validateStatus: expect.any(Function),
    };

    it('should handle successful GET request', async () => {
      const mockResponse: AxiosResponse = {
        data: { id: 1, name: 'Test' },
        status: HTTP_CONFIG.STATUS.OK_MIN,
        statusText: 'OK',
        headers: mockHeaders,
        config: mockConfig,
      };
      mockRequest.mockResolvedValueOnce(mockResponse);

      const result = await client.get('/test');

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockResponse.data);
      }
    });

    it('should handle failed GET request', async () => {
      const mockError = new Error('Request failed') as AxiosError;
      mockError.isAxiosError = true;
      mockError.response = {
        status: HTTP_CONFIG.STATUS.CLIENT_ERROR_MIN,
        data: 'Not found',
        statusText: 'Not Found',
        headers: {},
        config: mockConfig,
      };
      mockRequest.mockRejectedValueOnce(mockError);

      const result = await client.get('/test');

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toBeInstanceOf(APIError);
      }
    });

    it('should retry failed requests', async () => {
      const mockError = new Error('Server error') as AxiosError;
      mockError.response = {
        status: HTTP_CONFIG.STATUS.SERVER_ERROR_MIN,
        data: 'Server Error',
        statusText: 'Internal Server Error',
        headers: {},
        config: mockConfig,
      };
      mockError.isAxiosError = true;
      const mockSuccess: AxiosResponse = {
        data: { success: true },
        status: HTTP_CONFIG.STATUS.OK_MIN,
        statusText: 'OK',
        headers: mockHeaders,
        config: mockConfig,
      };

      mockRequest
        .mockRejectedValueOnce(mockError)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const result = await client.get('/test');

      expect(mockRequest).toHaveBeenCalledTimes(3);
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(mockSuccess.data);
      }
    });
  });
});
