export const enum Role {
  Dono = 1,
  Admin = 2,
  Moderador = 3,
  Usuario = 4
}

export function hasAtLeastRole(userRole: Role, required: Role): boolean {
  return userRole <= required;
}
