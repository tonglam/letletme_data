import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import expressPinoLogger from 'pino-http';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Prisma
const prisma = new PrismaClient();

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Cron job

// Import the router

// Middleware
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

// Start the server
const server = app.listen(port, () => {
  console.log(`Server is listening at http://localhost:${port}`);
});

export { logger, prisma, server };
