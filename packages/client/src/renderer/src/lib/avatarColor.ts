const PALETTE = ['#5b6dfa', '#e57373', '#4db6ac', '#ffb74d', '#ba68c8', '#4fc3f7', '#81c784'];

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
