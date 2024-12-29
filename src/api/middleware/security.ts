/**
 * Security middleware module
 * @module api/middleware/security
 */

import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SECURITY_CONFIG } from '../../config/api/api.config';

/**
 * Rate limiting middleware configuration
 */
const rateLimiter = rateLimit({
  windowMs: SECURITY_CONFIG.RATE_LIMIT.WINDOW_MS,
  max: SECURITY_CONFIG.RATE_LIMIT.MAX_REQUESTS,
  message: SECURITY_CONFIG.RATE_LIMIT.MESSAGE,
});

/**
 * Combined security middleware array
 * - Helmet: Helps secure Express apps by setting various HTTP headers
 * - CORS: Enables Cross-Origin Resource Sharing with default configuration
 * - Rate Limiter: Prevents abuse by limiting request rates per IP
 */
export const securityMiddleware = [
  helmet(SECURITY_CONFIG.HELMET),
  cors(SECURITY_CONFIG.CORS),
  rateLimiter,
] as const;
