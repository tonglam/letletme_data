import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  PlayerId,
  PrismaPlayer,
  toDomainPlayer,
  validatePlayerId,
} from '../../src/domain/player/types';
import { ElementType } from '../../src/types/base.type';
import { ElementResponse, ElementResponseSchema } from '../../src/types/element.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Domain Tests', () => {
  let testPlayers: ElementResponse[];

  beforeAll(() => {
    // Parse and validate test data
    testPlayers = bootstrapData.elements.map((element) => ElementResponseSchema.parse(element));
  });

  describe('Domain Model Transformation', () => {
    it('should transform API response to domain model', () => {
      const response = testPlayers[0];
      const player = toDomainPlayer(response);

      expect(player).toMatchObject({
        id: expect.any(Number),
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.any(Number),
        webName: expect.any(String),
      });

      // Verify field transformations
      expect(player.id).toBe(response.id);
      expect(player.elementCode).toBe(response.code);
      expect(player.price).toBe(response.now_cost);
      expect(player.startPrice).toBe(response.cost_change_start);
      expect(player.elementType).toBe(getElementTypeById(response.element_type));
      expect(player.webName).toBe(response.web_name);
      expect(player.firstName).toBe(response.first_name);
      expect(player.secondName).toBe(response.second_name);
      expect(player.teamId).toBe(response.team);
    });

    it('should transform Prisma model to domain model', () => {
      const apiPlayer = testPlayers[0];
      const prismaPlayer: PrismaPlayer = {
        element: apiPlayer.id,
        elementCode: apiPlayer.code,
        price: apiPlayer.now_cost,
        startPrice: apiPlayer.cost_change_start,
        elementType: getElementTypeById(apiPlayer.element_type) ?? ElementType.GKP,
        firstName: apiPlayer.first_name,
        secondName: apiPlayer.second_name,
        webName: apiPlayer.web_name,
        teamId: apiPlayer.team,
        createdAt: new Date(),
      };
      const player = toDomainPlayer(prismaPlayer);

      expect(player).toMatchObject({
        id: prismaPlayer.element,
        elementCode: prismaPlayer.elementCode,
        price: prismaPlayer.price,
        startPrice: prismaPlayer.startPrice,
        elementType: prismaPlayer.elementType,
        firstName: prismaPlayer.firstName,
        secondName: prismaPlayer.secondName,
        webName: prismaPlayer.webName,
        teamId: prismaPlayer.teamId,
      });
    });

    it('should handle optional and null fields correctly', () => {
      // Test with null first name and second name
      const responseWithNull = ElementResponseSchema.parse({
        ...testPlayers[0],
        first_name: null,
        second_name: null,
      });
      const playerWithNull = toDomainPlayer(responseWithNull);
      expect(playerWithNull.firstName).toBeNull();
      expect(playerWithNull.secondName).toBeNull();

      // Test with missing optional fields
      const basePlayer = testPlayers[0];
      const responseWithMissing = ElementResponseSchema.parse({
        id: basePlayer.id,
        code: basePlayer.code,
        element_type: basePlayer.element_type,
        now_cost: basePlayer.now_cost,
        cost_change_start: basePlayer.cost_change_start,
        web_name: basePlayer.web_name,
        team: basePlayer.team,
        first_name: null,
        second_name: null,
        minutes: 0,
        goals_scored: 0,
        assists: 0,
        clean_sheets: 0,
        goals_conceded: 0,
        own_goals: 0,
        penalties_saved: 0,
        yellow_cards: 0,
        red_cards: 0,
        saves: 0,
        bonus: 0,
        bps: 0,
        form: null,
        influence: null,
        creativity: null,
        threat: null,
        ict_index: null,
        starts: 0,
        expected_goals: null,
        expected_assists: null,
        expected_goal_involvements: null,
        expected_goals_conceded: null,
        influence_rank: null,
        influence_rank_type: null,
        creativity_rank: null,
        creativity_rank_type: null,
        threat_rank: null,
        threat_rank_type: null,
        ict_index_rank: null,
        ict_index_rank_type: null,
        status: 'a',
        event_points: 0,
        team_code: basePlayer.team,
        total_points: 0,
        transfers_in: 0,
        transfers_out: 0,
      });
      const playerWithMissing = toDomainPlayer(responseWithMissing);
      expect(playerWithMissing.firstName).toBeNull();
      expect(playerWithMissing.secondName).toBeNull();
    });

    it('should enforce business logic constraints', () => {
      // Find a valid player to base our test on
      const validPlayer = testPlayers.find((p) => p.now_cost > 0);
      expect(validPlayer).toBeDefined();
      if (!validPlayer) return;

      const player = toDomainPlayer(validPlayer);
      expect(player.price).toBeGreaterThan(0);
      expect(Object.values(ElementType)).toContain(player.elementType);
    });
  });

  describe('Player ID Validation', () => {
    it('should validate valid player ID', () => {
      const result = validatePlayerId(testPlayers[0].id);
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((id) => {
          expect(id).toBe(testPlayers[0].id);
          expect(typeof id).toBe('number');
        }),
      );
    });

    it('should reject invalid player ID types', () => {
      const testCases = [
        { input: 'invalid' },
        { input: null },
        { input: undefined },
        { input: {} },
        { input: [] },
      ];

      testCases.forEach(({ input }) => {
        const result = validatePlayerId(input as number);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid player ID');
      });
    });

    it('should reject invalid numeric values', () => {
      const testCases = [
        { input: 0 },
        { input: -1 },
        { input: 1.5 },
        { input: Infinity },
        { input: NaN },
      ];

      testCases.forEach(({ input }) => {
        const result = validatePlayerId(input);
        expect(E.isLeft(result)).toBe(true);
        if (E.isRight(result)) return;
        expect(result.left).toContain('Invalid player ID');
      });
    });

    it('should create branded type for valid ID', () => {
      const validIds = testPlayers.map((p) => p.id);

      validIds.forEach((id) => {
        const result = validatePlayerId(id);
        pipe(
          result,
          E.map((validId) => {
            const typedId: PlayerId = validId;
            expect(typedId).toBe(id);
          }),
        );
      });
    });
  });

  describe('Player Aggregates', () => {
    it('should validate player relationships', () => {
      const players = testPlayers
        .map((player) => toDomainPlayer(player))
        .sort((a, b) => a.id - b.id);

      const sortedTestPlayers = [...testPlayers].sort((a, b) => a.id - b.id);

      // Verify sequential IDs
      players.forEach((player, index) => {
        expect(player.id).toBe(sortedTestPlayers[index].id);
      });

      // Verify player team relationships
      const teamIds = new Set(players.map((p) => p.teamId));
      expect(teamIds.size).toBeGreaterThan(0);
      expect(Math.min(...teamIds)).toBeGreaterThan(0);

      // Verify player element types
      players.forEach((player) => {
        expect(Object.values(ElementType)).toContain(player.elementType);
      });

      // Verify player prices
      players.forEach((player) => {
        // Current price should be non-negative
        expect(player.price).toBeGreaterThanOrEqual(0);
        // Start price can be negative due to price changes
        expect(typeof player.startPrice).toBe('number');
        expect(Number.isFinite(player.startPrice)).toBe(true);
      });
    });
  });
});

// Helper function to get ElementType by ID (similar to the one in base.type.ts)
const getElementTypeById = (id: number): ElementType | null => {
  switch (id) {
    case 1:
      return ElementType.GKP;
    case 2:
      return ElementType.DEF;
    case 3:
      return ElementType.MID;
    case 4:
      return ElementType.FWD;
    default:
      return null;
  }
};
