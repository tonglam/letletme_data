import { PrismaClient } from '@prisma/client';
import { Phase, PhaseCreate, PhaseRepository } from './types';

export class PrismaPhaseRepository implements PhaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(phase: PhaseCreate): Promise<Phase> {
    return this.prisma.phase.create({
      data: {
        id: phase.id,
        name: phase.name,
        startEventId: phase.startEventId,
        stopEventId: phase.stopEventId,
      },
    });
  }

  async findById(id: number): Promise<Phase | null> {
    return this.prisma.phase.findUnique({
      where: { id },
    });
  }

  async findAll(): Promise<Phase[]> {
    return this.prisma.phase.findMany({
      orderBy: { startEventId: 'asc' },
    });
  }

  async update(id: number, phase: Partial<PhaseCreate>): Promise<Phase> {
    return this.prisma.phase.update({
      where: { id },
      data: phase,
    });
  }
}
