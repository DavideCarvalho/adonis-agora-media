/** The media pages' texts in the account console, `locale → key → text` (keys under `media.`). */
export const ACCOUNT_MESSAGES = {
  en: {
    'media.files.title': 'My files',
    'media.files.nav': 'Files',
    'media.files.empty': 'No files yet.',
    'media.files.list_title': 'Files',
    'media.files.no_upload_js': 'Uploading a file needs JavaScript.',
    'media.files.download': 'Download',
    'media.files.rename': 'Rename',
    'media.files.rename_field': 'New name',
    'media.files.renamed': 'File renamed.',
    'media.files.name_required': 'Enter a name.',
    'media.files.name_too_long': 'The name is too long (255 characters at most).',
    'media.files.delete': 'Delete',
    'media.files.delete_confirm': 'Delete this file? This cannot be undone.',
    'media.files.deleted': 'File deleted.',
    'media.files.upload': 'Upload',
    'media.files.uploaded': 'File uploaded.',
    'media.files.not_found': 'File not found.',
    'media.files.forbidden': 'You cannot do that with this file.',
    'media.files.no_tenant': 'Choose an organization to see its files.',
    'media.upload.choose': 'File',
    'media.upload.pick': 'Choose a file first.',
    'media.upload.too_large': 'This file is too large.',
    'media.upload.uploading': 'Uploading…',
    'media.upload.failed': 'The upload failed. Try again.',
  },
  'pt-BR': {
    'media.files.title': 'Meus arquivos',
    'media.files.nav': 'Arquivos',
    'media.files.empty': 'Nenhum arquivo ainda.',
    'media.files.list_title': 'Arquivos',
    'media.files.no_upload_js': 'Enviar um arquivo precisa de JavaScript.',
    'media.files.download': 'Baixar',
    'media.files.rename': 'Renomear',
    'media.files.rename_field': 'Novo nome',
    'media.files.renamed': 'Arquivo renomeado.',
    'media.files.name_required': 'Informe um nome.',
    'media.files.name_too_long': 'O nome é longo demais (no máximo 255 caracteres).',
    'media.files.delete': 'Excluir',
    'media.files.delete_confirm': 'Excluir este arquivo? Isso não pode ser desfeito.',
    'media.files.deleted': 'Arquivo excluído.',
    'media.files.upload': 'Enviar',
    'media.files.uploaded': 'Arquivo enviado.',
    'media.files.not_found': 'Arquivo não encontrado.',
    'media.files.forbidden': 'Você não pode fazer isso com este arquivo.',
    'media.files.no_tenant': 'Escolha uma organização para ver os arquivos dela.',
    'media.upload.choose': 'Arquivo',
    'media.upload.pick': 'Escolha um arquivo primeiro.',
    'media.upload.too_large': 'Este arquivo é grande demais.',
    'media.upload.uploading': 'Enviando…',
    'media.upload.failed': 'O envio falhou. Tente de novo.',
  },
} as const;

type Locale = keyof typeof ACCOUNT_MESSAGES;

/** A message in `locale` (its language, else English), for texts authkit does not translate. */
export function message(locale: string, key: keyof (typeof ACCOUNT_MESSAGES)['en']): string {
  const exact = ACCOUNT_MESSAGES[locale as Locale];
  if (exact) return exact[key];
  const language = locale.split('-')[0];
  const close = (Object.keys(ACCOUNT_MESSAGES) as Locale[]).find(
    (candidate) => candidate.split('-')[0] === language,
  );
  return ACCOUNT_MESSAGES[close ?? 'en'][key];
}
