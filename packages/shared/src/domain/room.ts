export interface RoomSummary {
  id: string;
  serverId: string;
  name: string;
  memberCount: number;
  maxMembers: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerUserId: string;
}
