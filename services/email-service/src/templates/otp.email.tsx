import { Text, Section } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

const translations = {
  en: {
    default: {
      preview: (code: string) => `Your verification code: ${code}`,
      heading: "Verification Code",
      subtext: "Use the following code to verify your Atto account:",
      disclaimer:
        "If you didn't request this code, you can safely ignore this email. No one can access your account without this code.",
    },
    delete_account: {
      preview: (code: string) => `Account deletion code: ${code}`,
      heading: "Account Deletion",
      subtext:
        "You requested to delete your ATTO SOUND account. Use the following code to confirm:",
      disclaimer:
        "If you didn't request this, do not share this code. Your account will remain safe.",
    },
  },
  es: {
    default: {
      preview: (code: string) => `Tu código de verificación: ${code}`,
      heading: "Código de verificación",
      subtext: "Usa el siguiente código para verificar tu cuenta de Atto:",
      disclaimer:
        "Si no solicitaste este código, puedes ignorar este correo de forma segura. Nadie puede acceder a tu cuenta sin este código.",
    },
    delete_account: {
      preview: (code: string) => `Código de eliminación de cuenta: ${code}`,
      heading: "Eliminación de cuenta",
      subtext:
        "Solicitaste eliminar tu cuenta de ATTO SOUND. Usa el siguiente código para confirmar:",
      disclaimer:
        "Si no solicitaste esto, no compartas este código. Tu cuenta permanecerá segura.",
    },
  },
  "pt-BR": {
    default: {
      preview: (code: string) => `Seu código de verificação: ${code}`,
      heading: "Código de verificação",
      subtext: "Use o código a seguir para verificar sua conta Atto:",
      disclaimer:
        "Se você não solicitou este código, pode ignorar este e-mail com segurança. Ninguém pode acessar sua conta sem este código.",
    },
    delete_account: {
      preview: (code: string) => `Código de exclusão de conta: ${code}`,
      heading: "Exclusão de conta",
      subtext:
        "Você solicitou a exclusão da sua conta ATTO SOUND. Use o código a seguir para confirmar:",
      disclaimer:
        "Se você não solicitou isso, não compartilhe este código. Sua conta permanecerá segura.",
    },
  },
} as const;

const expiryTranslations = {
  en: (min: number) =>
    `This code expires in <strong>${min} minutes</strong>.`,
  es: (min: number) =>
    `Este código expira en <strong>${min} minutos</strong>.`,
  "pt-BR": (min: number) =>
    `Este código expira em <strong>${min} minutos</strong>.`,
} as const;

type Locale = keyof typeof translations;
type Purpose = "default" | "delete_account";

function getTranslations(locale?: string, purpose?: string) {
  const lang: Locale =
    locale && locale in translations
      ? (locale as Locale)
      : locale?.startsWith("pt")
        ? "pt-BR"
        : locale?.startsWith("es")
          ? "es"
          : "en";
  const p: Purpose = purpose === "delete_account" ? "delete_account" : "default";
  return translations[lang][p];
}

function getExpiry(locale?: string) {
  if (locale && locale in expiryTranslations)
    return expiryTranslations[locale as Locale];
  if (locale?.startsWith("pt")) return expiryTranslations["pt-BR"];
  if (locale?.startsWith("es")) return expiryTranslations.es;
  return expiryTranslations.en;
}

interface OtpEmailProps {
  code: string;
  expiresMinutes: number;
  locale?: string;
  purpose?: string;
}

export const OtpEmail: React.FC<OtpEmailProps> = ({
  code = "123456",
  expiresMinutes = 10,
  locale = "en",
  purpose,
}) => {
  const t = getTranslations(locale, purpose);
  const expiry = getExpiry(locale);

  return (
    <Layout preview={t.preview(code)} lang={locale || "en"} variant="light">
      <Text style={heading}>{t.heading}</Text>
      <Text style={subtext}>{t.subtext}</Text>

      <Section style={codeContainer}>
        <Text style={codeStyle}>{code}</Text>
      </Section>

      <Text
        style={expiryText}
        dangerouslySetInnerHTML={{ __html: expiry(expiresMinutes) }}
      />

      <Text style={disclaimerText}>{t.disclaimer}</Text>
    </Layout>
  );
};

export default OtpEmail;

const heading: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: 700,
  lineHeight: "32px",
  margin: "0 0 12px 0",
};

const subtext: React.CSSProperties = {
  color: "#555555",
  fontSize: "16px",
  lineHeight: "24px",
  margin: "0 0 32px 0",
};

const codeContainer: React.CSSProperties = {
  backgroundColor: "#F7F7F7",
  borderRadius: "8px",
  border: "1px solid #E5E5E5",
  padding: "28px 24px",
  textAlign: "center" as const,
  margin: "0 0 24px 0",
};

const codeStyle: React.CSSProperties = {
  color: "#000000",
  fontFamily: '"Courier New", Courier, monospace',
  fontSize: "44px",
  fontWeight: 700,
  letterSpacing: "12px",
  lineHeight: "1",
  margin: 0,
};

const expiryText: React.CSSProperties = {
  color: "#555555",
  fontSize: "14px",
  lineHeight: "20px",
  margin: "0 0 24px 0",
};

const disclaimerText: React.CSSProperties = {
  color: "#999999",
  fontSize: "13px",
  lineHeight: "20px",
  margin: 0,
};
