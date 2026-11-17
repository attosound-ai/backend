// Textos del correo de borrado con 30 días de gracia (12 nov 2026). Puro, sin
// React, para poder probarlo y revisarlo sin renderizar. Sin guiones ni rayas
// en ningún idioma (regla de David).

export type DeletionEmailKind = "scheduled" | "recovered";

type Copy = {
  subject: string;
  preview: string;
  heading: string;
  paragraphs: string[];
  footnote: string;
};

type Locale = "en" | "es" | "pt-BR";

export function pickLocale(locale?: string): Locale {
  const l = (locale ?? "").toLowerCase();
  if (l.startsWith("pt")) return "pt-BR";
  if (l.startsWith("es")) return "es";
  return "en";
}

/**
 * La fecha del borrado como la lee una persona ("December 12, 2026",
 * "12 de diciembre de 2026", "12 de dezembro de 2026"). En UTC: el servidor
 * no sabe en qué zona vive la persona, y el borrado corre a esa hora UTC.
 * Devuelve "" si la fecha no es válida (el correo entonces no la nombra).
 */
export function formatDeletionDate(iso: string | undefined, locale?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(pickLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function deletionEmailCopy(
  kind: DeletionEmailKind,
  username: string,
  dateText: string,
  locale?: string,
): Copy {
  const who = username ? `@${username}` : "";
  const lang = pickLocale(locale);
  if (kind === "recovered") {
    switch (lang) {
      case "es":
        return {
          subject: "Recuperaste tu cuenta de Atto",
          preview: "Tu cuenta vuelve a estar activa.",
          heading: "Tu cuenta vuelve a estar activa",
          paragraphs: [
            `Recuperaste tu cuenta ${who}. Ya no se va a borrar: tu perfil, tus posts y tus mensajes se ven otra vez.`,
            "Por seguridad cerramos la sesión en tus otros dispositivos. Vuelve a entrar en ellos si los usas.",
          ],
          footnote:
            "Si no fuiste tú, cambia tu contraseña desde la app ahora mismo.",
        };
      case "pt-BR":
        return {
          subject: "Você recuperou sua conta do Atto",
          preview: "Sua conta está ativa de novo.",
          heading: "Sua conta está ativa de novo",
          paragraphs: [
            `Você recuperou sua conta ${who}. Ela não vai mais ser excluída: seu perfil, seus posts e suas mensagens aparecem de novo.`,
            "Por segurança, encerramos a sessão nos seus outros dispositivos. Entre de novo neles se você os usa.",
          ],
          footnote: "Se não foi você, troque sua senha no app agora mesmo.",
        };
      default:
        return {
          subject: "You recovered your Atto account",
          preview: "Your account is active again.",
          heading: "Your account is active again",
          paragraphs: [
            `You recovered your account ${who}. It will not be deleted: your profile, posts and messages are visible again.`,
            "For your security we signed you out on your other devices. Sign in again on them if you use them.",
          ],
          footnote: "If this was not you, change your password in the app right away.",
        };
    }
  }

  switch (lang) {
    case "es":
      return {
        subject: dateText
          ? `Tu cuenta de Atto se borrará el ${dateText}`
          : "Tu cuenta de Atto se va a borrar",
        preview: "Tienes 30 días para arrepentirte.",
        heading: dateText
          ? `Tu cuenta se borrará el ${dateText}`
          : "Tu cuenta se va a borrar",
        paragraphs: [
          `Desactivamos tu cuenta ${who} porque pediste borrarla. Desde ahora nadie ve tu perfil, tus posts ni tus mensajes, y no recibirás notificaciones.`,
          dateText
            ? `El ${dateText} la borraremos para siempre, con todo lo que tiene. Eso no se puede deshacer.`
            : "Dentro de 30 días la borraremos para siempre, con todo lo que tiene. Eso no se puede deshacer.",
          "¿Cambiaste de idea? Vuelve a entrar en Atto antes de esa fecha y toca Recuperar. Tu cuenta vuelve tal como estaba.",
        ],
        footnote:
          "Si no pediste borrar tu cuenta, entra en la app, recupérala y cambia tu contraseña.",
      };
    case "pt-BR":
      return {
        subject: dateText
          ? `Sua conta do Atto será excluída em ${dateText}`
          : "Sua conta do Atto vai ser excluída",
        preview: "Você tem 30 dias para mudar de ideia.",
        heading: dateText
          ? `Sua conta será excluída em ${dateText}`
          : "Sua conta vai ser excluída",
        paragraphs: [
          `Desativamos sua conta ${who} porque você pediu a exclusão dela. A partir de agora ninguém vê seu perfil, seus posts nem suas mensagens, e você não recebe notificações.`,
          dateText
            ? `Em ${dateText} vamos excluir sua conta para sempre, com tudo o que ela tem. Isso não pode ser desfeito.`
            : "Daqui a 30 dias vamos excluir sua conta para sempre, com tudo o que ela tem. Isso não pode ser desfeito.",
          "Mudou de ideia? Entre de novo no Atto antes dessa data e toque em Recuperar. Sua conta volta do jeito que estava.",
        ],
        footnote:
          "Se você não pediu para excluir sua conta, entre no app, recupere sua conta e troque sua senha.",
      };
    default:
      return {
        subject: dateText
          ? `Your Atto account will be deleted on ${dateText}`
          : "Your Atto account will be deleted",
        preview: "You have 30 days to change your mind.",
        heading: dateText
          ? `Your account will be deleted on ${dateText}`
          : "Your account will be deleted",
        paragraphs: [
          `We deactivated your account ${who} because you asked us to delete it. From now on nobody can see your profile, posts or messages, and you will not get notifications.`,
          dateText
            ? `On ${dateText} we will delete it for good, with everything in it. That cannot be undone.`
            : "In 30 days we will delete it for good, with everything in it. That cannot be undone.",
          "Changed your mind? Sign in to Atto again before that date and tap Recover. Your account comes back just as it was.",
        ],
        footnote:
          "If you did not ask to delete your account, sign in to the app, recover it and change your password.",
      };
  }
}
