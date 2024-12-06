import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import expressPinoLogger from 'pino-http';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressPinoLogger({ logger }));
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
  next();
});

// Routes
app.get('/', (req: Request, res: Response) => {
  res.send('Hello, TypeScript!');
});

let server: ReturnType<typeof app.listen> | null = null;

// Start server function
const startServer = (customPort?: number) => {
  const serverPort = customPort || port;
  server = app.listen(serverPort, () => {
    console.log(`Server is listening at http://localhost:${serverPort}`);
  });
  return server;
};

// Stop server function
const stopServer = async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
  }
};

// Only start server if this file is run directly
if (require.main === module) {
  startServer();
}

export { app, logger, prisma, startServer, stopServer };
