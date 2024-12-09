import { PrismaClient } from '@prisma/client';

// Single instance of PrismaClient
const prisma = new PrismaClient();

export { prisma };
