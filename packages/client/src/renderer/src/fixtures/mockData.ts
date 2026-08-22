import type { RoomSummary, ServerSummary } from '@concord/shared';

/**
 * Static placeholder data — only for previewing layout/visual design.
 * Replace with real data once the server/DB integration is wired.
 */
export interface MockServer extends ServerSummary {
  unreadCount?: number;
}

export const mockServers: MockServer[] = [
  { id: 'srv-1', name: 'Concord HQ', iconUrl: null, unreadCount: 12 },
  { id: 'srv-2', name: 'Rebentos', iconUrl: null },
  { id: 'srv-3', name: 'Amigos', iconUrl: null, unreadCount: 3 },
  { id: 'srv-4', name: 'Estúdio', iconUrl: null, unreadCount: 5 }
];

export const mockRoomsByServer: Record<string, RoomSummary[]> = {
  'srv-1': [
    { id: 'room-1', serverId: 'srv-1', name: 'Random', memberCount: 0, maxMembers: 10 },
    { id: 'room-2', serverId: 'srv-1', name: 'Geral', memberCount: 4, maxMembers: 10 },
    { id: 'room-3', serverId: 'srv-1', name: 'dev', memberCount: 2, maxMembers: 10 },
    { id: 'room-4', serverId: 'srv-1', name: 'off-topic', memberCount: 0, maxMembers: 10 }
  ],
  'srv-2': [{ id: 'room-5', serverId: 'srv-2', name: 'gravação', memberCount: 1, maxMembers: 10 }],
  'srv-3': [{ id: 'room-6', serverId: 'srv-3', name: 'sala principal', memberCount: 3, maxMembers: 10 }],
  'srv-4': [{ id: 'room-7', serverId: 'srv-4', name: 'produção', memberCount: 0, maxMembers: 10 }]
};

export const mockCurrentUser = {
  displayName: 'Mozar',
  statusLabel: 'Disponível'
};

/**
 * Other participants already "in" each voice room — count matches the
 * room's memberCount above. Purely for previewing the sidebar's second-layer
 * participant list and the room-view grid with more than one tile.
 */
export const mockParticipantsByRoom: Record<string, string[]> = {
  'room-2': ['Barcoolla', 'Ryan', 'Ana', 'Théo'],
  'room-3': ['Pedro', 'Larissa'],
  'room-5': ['Vava'],
  'room-6': ['Bruno', 'Carla', 'Diego']
};
