import { describe, expect, it } from 'vitest';

import {
  mapDomainPlayerToPrismaCreate,
  mapPrismaPlayerToDomain,
} from '../../../src/repositories/player/mapper';
import { PrismaPlayerCreate } from '../../../src/repositories/player/type';
import { ElementType } from '../../../src/types/base.type';
import { PlayerId } from '../../../src/types/domain/player.type';

describe('Player Mappers', () => {
  describe('mapPrismaPlayerToDomain', () => {
    it('should correctly map Prisma player to domain player', () => {
      // Arrange
      const prismaPlayer = {
        element: 1,
        elementCode: 1,
        price: 50, // stored as price * 10
        startPrice: 50,
        elementType: ElementType.FORWARD,
        firstName: 'John',
        secondName: 'Doe',
        webName: 'Doe',
        teamId: 1,
        createdAt: new Date(),
      };

      // Act
      const result = mapPrismaPlayerToDomain(prismaPlayer);

      // Assert
      expect(result).toEqual({
        id: 1 as PlayerId,
        elementCode: 1,
        price: 5, // should divide by 10
        startPrice: 5, // should divide by 10
        elementType: ElementType.FORWARD,
        firstName: 'John',
        secondName: 'Doe',
        webName: 'Doe',
        teamId: 1,
      });
    });

    it('should handle null values for firstName and secondName', () => {
      // Arrange
      const prismaPlayer = {
        element: 1,
        elementCode: 1,
        price: 50,
        startPrice: 50,
        elementType: ElementType.FORWARD,
        firstName: null,
        secondName: null,
        webName: 'Unknown',
        teamId: 1,
        createdAt: new Date(),
      };

      // Act
      const result = mapPrismaPlayerToDomain(prismaPlayer);

      // Assert
      expect(result).toEqual({
        id: 1 as PlayerId,
        elementCode: 1,
        price: 5,
        startPrice: 5,
        elementType: ElementType.FORWARD,
        firstName: '',
        secondName: '',
        webName: 'Unknown',
        teamId: 1,
      });
    });
  });

  describe('mapDomainPlayerToPrismaCreate', () => {
    it('should correctly map domain player to Prisma player create input', () => {
      // Arrange
      const domainPlayer: PrismaPlayerCreate = {
        id: 1 as PlayerId,
        element: 1,
        elementCode: 1,
        price: 5, // stores as price * 10
        startPrice: 5,
        elementType: ElementType.FORWARD,
        firstName: 'John',
        secondName: 'Doe',
        webName: 'Doe',
        teamId: 1,
        createdAt: new Date(),
      };

      // Act
      const result = mapDomainPlayerToPrismaCreate(domainPlayer);

      // Assert
      expect(result).toEqual({
        element: 1,
        elementCode: 1,
        price: 50, // multiplied by 10
        startPrice: 50, // multiplied by 10
        elementType: ElementType.FORWARD,
        firstName: 'John',
        secondName: 'Doe',
        webName: 'Doe',
        teamId: 1,
      });
    });

    it('should handle null values for firstName and secondName', () => {
      // Arrange
      const domainPlayer: PrismaPlayerCreate = {
        id: 2 as PlayerId,
        element: 2,
        elementCode: 2,
        price: 6.5,
        startPrice: 6.5,
        elementType: ElementType.MIDFIELDER,
        firstName: null,
        secondName: null,
        webName: 'Unknown',
        teamId: 2,
        createdAt: new Date(),
      };

      // Act
      const result = mapDomainPlayerToPrismaCreate(domainPlayer);

      // Assert
      expect(result).toEqual({
        element: 2,
        elementCode: 2,
        price: 65, // multiplied by 10
        startPrice: 65, // multiplied by 10
        elementType: ElementType.MIDFIELDER,
        firstName: null,
        secondName: null,
        webName: 'Unknown',
        teamId: 2,
      });
    });
  });
});
