import { Text, Section } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

const translations = {
  en: {
    preview: (code: string) => `Your password reset code: ${code}`,
    heading: "Reset Password",
    subtext:
      "We received a request to reset your Atto account password. Enter this code in the app:",
    expiry: (min: number) =>
      `This code expires in <strong>${min} minutes</strong>.`,
    warning:
      "If you didn't request a password reset, ignore this email. Your account is still secure.",
  },
  es: {
    preview: (code: string) => `Tu código de restablecimiento: ${code}`,
    heading: "Restablecer contraseña",
    subtext:
      "Recibimos una solicitud para restablecer la contraseña de tu cuenta de Atto. Ingresa este código en la app:",
    expiry: (min: number) =>
      `Este código expira en <strong>${min} minutos</strong>.`,
    warning:
      "Si no solicitaste restablecer tu contraseña, ignora este correo. Tu cuenta sigue segura.",
  },
  "pt-BR": {
    preview: (code: string) => `Seu código de redefinição: ${code}`,
    heading: "Redefinir senha",
    subtext:
      "Recebemos uma solicitação para redefinir a senha da sua conta Atto. Insira este código no app:",
    expiry: (min: number) =>
      `Este código expira em <strong>${min} minutos</strong>.`,
    warning:
      "Se você não solicitou a redefinição de senha, ignore este e-mail. Sua conta continua segura.",
  },
} as const;

type Locale = keyof typeof translations;

function getTranslations(locale?: string) {
  if (locale && locale in translations) return translations[locale as Locale];
  if (locale?.startsWith("pt")) return translations["pt-BR"];
  if (locale?.startsWith("es")) return translations.es;
  return translations.en;
}

interface PasswordResetEmailProps {
  code: string;
  expiresMinutes: number;
  locale?: string;
}

export const PasswordResetEmail: React.FC<PasswordResetEmailProps> = ({
  code = "123456",
  expiresMinutes = 10,
  locale = "en",
}) => {
  const t = getTranslations(locale);

  return (
    <Layout preview={t.preview(code)} lang={locale || "en"} variant="light">
      <Text style={heading}>{t.heading}</Text>
      <Text style={subtext}>{t.subtext}</Text>

      <Section style={codeContainer}>
        <Text style={codeStyle}>{code}</Text>
      </Section>

      <Text
        style={expiryText}
        dangerouslySetInnerHTML={{ __html: t.expiry(expiresMinutes) }}
      />

      <Text style={disclaimerText}>{t.warning}</Text>
    </Layout>
  );
};

export default PasswordResetEmail;

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
