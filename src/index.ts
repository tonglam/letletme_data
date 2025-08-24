import cors from 'cors';
import express from 'express';

import { eventsAPI } from './api/events';
import { teamsAPI } from './api/teams';
import { startEventsJob, triggerEventsJob } from './jobs/events';
import { startTeamsJob, triggerTeamsJob } from './jobs/teams';
import { getErrorMessage, getErrorStatus } from './utils/errors';
import { logError, logInfo } from './utils/logger';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logInfo('HTTP Request', {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
  });
  next();
});

// Health check endpoints
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Letletme Data API - Simplified Architecture',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// Events API routes
app.get('/events', eventsAPI.getAllEvents);
app.get('/events/current', eventsAPI.getCurrentEvent);
app.get('/events/next', eventsAPI.getNextEvent);
app.get('/events/:id', eventsAPI.getEventById);
app.post('/events/sync', eventsAPI.syncEvents);
app.delete('/events/cache', eventsAPI.clearCache);

// Teams API routes
app.get('/teams', teamsAPI.getAllTeams);
app.get('/teams/:id', teamsAPI.getTeamById);
app.post('/teams/sync', teamsAPI.syncTeams);
app.delete('/teams/cache', teamsAPI.clearCache);

// Jobs API routes (for manual triggering)
app.post('/jobs/events/trigger', async (req, res) => {
  try {
    await triggerEventsJob();
    res.json({ success: true, message: 'Events job triggered successfully' });
  } catch (error) {
    const message = getErrorMessage(error);
    const status = getErrorStatus(error);
    res.status(status).json({ success: false, error: message });
  }
});

app.post('/jobs/teams/trigger', async (req, res) => {
  try {
    await triggerTeamsJob();
    res.json({ success: true, message: 'Teams job triggered successfully' });
  } catch (error) {
    const message = getErrorMessage(error);
    const status = getErrorStatus(error);
    res.status(status).json({ success: false, error: message });
  }
});

// Global error handler
app.use(
  (error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError('Unhandled API error', error, {
      method: req.method,
      url: req.url,
    });

    const message = getErrorMessage(error);
    const status = getErrorStatus(error);

    res.status(status).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    });
  },
);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
  });
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  logInfo('SIGTERM received, shutting down gracefully');

  // Stop all cron jobs
  // stopEventsJob(); // Uncomment when you add more jobs

  process.exit(0);
});

process.on('SIGINT', () => {
  logInfo('SIGINT received, shutting down gracefully');

  // Stop all cron jobs
  // stopEventsJob(); // Uncomment when you add more jobs

  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  logInfo('Server started successfully', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
  });

  // Start background jobs
  if (process.env.NODE_ENV !== 'test') {
    logInfo('Starting background jobs');
    startEventsJob();
    startTeamsJob();
  }
});

export default app;
