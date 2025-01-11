import { Prisma } from '@prisma/client';
import { ElementType } from '../../../types/base.type';
import { PlayerId } from '../../../types/player/base.type';
import { Player, PlayerCreate, PlayerUpdate } from '../../../types/player/command.type';

/**
 * Converts a Player or PlayerCreate to Prisma format for create operation
 */
export const toPrismaPlayerCreate = (input: Player | PlayerCreate): Prisma.PlayerCreateInput => {
  return {
    element: Number(input.id),
    elementCode: input.elementCode,
    elementType: input.elementType,
    webName: input.webName,
    teamId: input.teamId,
    price: input.price ?? 0,
    startPrice: input.startPrice ?? 0,
    firstName: input.firstName ?? null,
    secondName: input.secondName ?? null,
  };
};

/**
 * Converts a PlayerUpdate to Prisma format for update operation
 */
export const toPrismaPlayerUpdate = (input: PlayerUpdate): Prisma.PlayerUpdateInput => {
  const data: Prisma.PlayerUpdateInput = {};

  // Only include updatable fields that are present
  if (input.price !== undefined) data.price = input.price;
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.secondName !== undefined) data.secondName = input.secondName;
  if (input.webName !== undefined) data.webName = input.webName;
  if (input.teamId !== undefined) data.teamId = input.teamId;

  return data;
};

/**
 * Converts a Prisma player to domain format
 * Throws an error if the element ID is invalid
 */
export const toDomainPlayer = (prismaPlayer: {
  element: number;
  elementCode: number;
  price: number;
  startPrice: number;
  elementType: ElementType;
  firstName: string | null;
  secondName: string | null;
  webName: string;
  teamId: number;
}): Player => {
  // Validate the element ID
  const validationResult = PlayerId.validate(prismaPlayer.element);
  if ('left' in validationResult) {
    throw new Error(`Invalid player ID: ${validationResult.left}`);
  }

  return {
    id: validationResult.right,
    elementCode: prismaPlayer.elementCode,
    price: prismaPlayer.price,
    startPrice: prismaPlayer.startPrice,
    elementType: prismaPlayer.elementType,
    firstName: prismaPlayer.firstName,
    secondName: prismaPlayer.secondName,
    webName: prismaPlayer.webName,
    teamId: prismaPlayer.teamId,
  };
};
