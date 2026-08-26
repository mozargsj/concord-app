// Rotating copy banks for IllustratedNotice — kept in one place so every call site for the same
// case (access denied, upload/download failure) shares the same voice instead of drifting apart.
// Canonical source of truth is decisions.md; keep the two in sync when editing.

export const ACCESS_DENIED_MESSAGES = [
  'Essa porta é só pra quem tem a chave. Você não é dono nem admin aqui.',
  'O gato de guarda não deixou passar dessa vez.',
  'Acesso negado — nem miado convence esse portão.'
];

export const UPLOAD_FAILED_MESSAGES = [
  'A nuvem recusou o pacote e o gato não gostou nada disso.',
  'Tentou subir, não subiu. Deve ter faltado internet, paciência ou as duas coisas.',
  'O envio voltou correndo — parece que o servidor não estava esperando visita.'
];

export const LOGIN_FAILED_MESSAGES = [
  'O Google não reconheceu esse gato na porta. Tenta de novo.',
  'Login recusado — nem crachá, nem senha, nem miado convenceram dessa vez.',
  'Alguma coisa deu errado no meio do caminho do login. Tenta de novo?'
];
