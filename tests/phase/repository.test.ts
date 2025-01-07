import { readFileSync } from 'fs';
import { join } from 'path';
import { createPhaseRepository } from '../../src/domain/phase/repository';
import { Phase, PhaseId, PhaseResponse, toDomainPhase } from '../../src/domain/phase/types';
import { prisma } from '../../src/infrastructure/db/prisma';

// Load test data directly from JSON
const loadTestPhases = (): PhaseResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  return data.phases;
};

describe('Phase Repository', () => {
  const phaseRepository = createPhaseRepository(prisma);
  let testPhases: Phase[];
  const createdPhaseIds: number[] = [];

  beforeAll(() => {
    // Convert test data to domain models
    const phases = loadTestPhases().slice(0, 3);
    testPhases = phases.map((phase: PhaseResponse) => toDomainPhase(phase));
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.phase.deleteMany();
  });

  afterAll(async () => {
    // Clean up test data
    if (createdPhaseIds.length > 0) {
      await prisma.phase.deleteMany({
        where: {
          id: {
            in: createdPhaseIds,
          },
        },
      });
    }
    await prisma.$disconnect();
  });

  describe('save', () => {
    it('should save a phase', async () => {
      const phase = testPhases[0];
      const result = await phaseRepository.save(phase)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.id).toBe(phase.id);
        expect(result.right.name).toBe(phase.name);
        expect(result.right.startEvent).toBe(phase.startEvent);
        expect(result.right.stopEvent).toBe(phase.stopEvent);
        createdPhaseIds.push(Number(phase.id));
      }
    });

    it('should handle duplicate phase save', async () => {
      const phase = testPhases[0];
      await phaseRepository.save(phase)();
      const result = await phaseRepository.save(phase)();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.code).toBe('QUERY_ERROR');
      }
    });
  });

  describe('saveBatch', () => {
    it('should save multiple phases', async () => {
      const result = await phaseRepository.saveBatch(testPhases)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(testPhases.length);
        result.right.forEach((phase, index) => {
          expect(phase.id).toBe(testPhases[index].id);
          expect(phase.name).toBe(testPhases[index].name);
          createdPhaseIds.push(Number(phase.id));
        });
      }
    });
  });

  describe('findById', () => {
    it('should find phase by id', async () => {
      const phase = testPhases[0];
      await phaseRepository.save(phase)();
      const result = await phaseRepository.findById(phase.id)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right?.id).toBe(phase.id);
        expect(result.right?.name).toBe(phase.name);
      }
    });

    it('should return null for non-existent phase', async () => {
      const nonExistentId = 999 as PhaseId;
      const result = await phaseRepository.findById(nonExistentId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('findAll', () => {
    it('should find all phases', async () => {
      await phaseRepository.saveBatch(testPhases)();
      const result = await phaseRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(testPhases.length);
        result.right.forEach((phase, index) => {
          expect(phase.id).toBe(testPhases[index].id);
          expect(phase.name).toBe(testPhases[index].name);
        });
      }
    });

    it('should return empty array when no phases exist', async () => {
      const result = await phaseRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all phases', async () => {
      await phaseRepository.saveBatch(testPhases)();
      const result = await phaseRepository.deleteAll()();

      expect(result._tag).toBe('Right');
      const findResult = await phaseRepository.findAll()();
      expect(findResult._tag).toBe('Right');
      if (findResult._tag === 'Right') {
        expect(findResult.right).toHaveLength(0);
      }
    });
  });
});
