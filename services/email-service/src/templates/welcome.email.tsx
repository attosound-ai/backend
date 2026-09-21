import { Text, Button, Section } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

interface WelcomeEmailProps {
  name: string;
  role: "creator" | "representative" | "listener";
  appDeeplink?: string;
  /** BCP-47 (e.g. "en", "es", "pt-BR"). Falls back to English for any unknown value. */
  locale?: string;
}

type Strings = {
  preview: (name: string) => string;
  hello: (name: string) => string;
  greeting: string;
  description: string;
  cta: string;
  footer: string;
};

type Locale = "en" | "es" | "pt-BR";

const i18n: Record<Locale, Record<WelcomeEmailProps["role"], Strings>> = {
  en: {
    creator: {
      preview: (n) => `Welcome to Atto, ${n}!`,
      hello: (n) => `Hi, ${n}!`,
      greeting: "Your music deserves to be heard!",
      description:
        "You can now upload your music, connect with your audience, and grow your career from Atto.",
      cta: "Start uploading your music",
      footer:
        "If you have any questions, just reply to this email and we'll help.",
    },
    representative: {
      preview: (n) => `Welcome to Atto, ${n}!`,
      hello: (n) => `Hi, ${n}!`,
      greeting: "Thanks for joining as a representative!",
      description:
        "You can now connect with your loved one, manage their profile, and help them share their talent with the world.",
      cta: "Connect with your loved one",
      footer:
        "If you have any questions, just reply to this email and we'll help.",
    },
    listener: {
      preview: (n) => `Welcome to Atto, ${n}!`,
      hello: (n) => `Hi, ${n}!`,
      greeting: "Welcome to a new music experience!",
      description:
        "Discover unique artists, listen to stories that inspire, and join a community that connects through music.",
      cta: "Discover artists",
      footer:
        "If you have any questions, just reply to this email and we'll help.",
    },
  },
  es: {
    creator: {
      preview: (n) => `¡Bienvenido a Atto, ${n}!`,
      hello: (n) => `¡Hola, ${n}!`,
      greeting: "¡Tu música merece ser escuchada!",
      description:
        "Ya puedes subir tu música, conectar con tu audiencia y hacer crecer tu carrera desde Atto.",
      cta: "Empieza a subir tu música",
      footer:
        "Si tienes alguna pregunta, responde a este correo y te ayudaremos.",
    },
    representative: {
      preview: (n) => `¡Bienvenido a Atto, ${n}!`,
      hello: (n) => `¡Hola, ${n}!`,
      greeting: "¡Gracias por unirte como representante!",
      description:
        "Ahora puedes conectar con tu ser querido, gestionar su perfil y ayudarle a compartir su talento con el mundo.",
      cta: "Conecta con tu ser querido",
      footer:
        "Si tienes alguna pregunta, responde a este correo y te ayudaremos.",
    },
    listener: {
      preview: (n) => `¡Bienvenido a Atto, ${n}!`,
      hello: (n) => `¡Hola, ${n}!`,
      greeting: "¡Bienvenido a una nueva experiencia musical!",
      description:
        "Descubre artistas únicos, escucha historias que inspiran y forma parte de una comunidad que conecta a través de la música.",
      cta: "Descubre artistas",
      footer:
        "Si tienes alguna pregunta, responde a este correo y te ayudaremos.",
    },
  },
  "pt-BR": {
    creator: {
      preview: (n) => `Bem-vindo ao Atto, ${n}!`,
      hello: (n) => `Olá, ${n}!`,
      greeting: "Sua música merece ser ouvida!",
      description:
        "Agora você pode enviar suas músicas, se conectar com seu público e fazer sua carreira crescer pelo Atto.",
      cta: "Comece a enviar sua música",
      footer:
        "Se tiver dúvidas, responda a este e-mail e te ajudaremos.",
    },
    representative: {
      preview: (n) => `Bem-vindo ao Atto, ${n}!`,
      hello: (n) => `Olá, ${n}!`,
      greeting: "Obrigado por se juntar como representante!",
      description:
        "Agora você pode se conectar com seu ente querido, gerenciar o perfil dele e ajudá-lo a compartilhar seu talento com o mundo.",
      cta: "Conecte-se com seu ente querido",
      footer:
        "Se tiver dúvidas, responda a este e-mail e te ajudaremos.",
    },
    listener: {
      preview: (n) => `Bem-vindo ao Atto, ${n}!`,
      hello: (n) => `Olá, ${n}!`,
      greeting: "Bem-vindo a uma nova experiência musical!",
      description:
        "Descubra artistas únicos, ouça histórias que inspiram e faça parte de uma comunidade que se conecta pela música.",
      cta: "Descobrir artistas",
      footer:
        "Se tiver dúvidas, responda a este e-mail e te ajudaremos.",
    },
  },
};

function normalizeLocale(input?: string): Locale {
  if (!input) return "en";
  const lower = input.toLowerCase();
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("es")) return "es";
  return "en";
}

export const WelcomeEmail: React.FC<WelcomeEmailProps> = ({
  name = "Usuario",
  role = "listener",
  appDeeplink = "atto://",
  locale,
}) => {
  const resolved: Locale = normalizeLocale(locale);
  const content = i18n[resolved][role];

  return (
    <Layout
      preview={content.preview(name)}
      lang={resolved === "pt-BR" ? "pt" : resolved}
    >
      <Text style={heading}>{content.hello(name)}</Text>
      <Text style={subheading}>{content.greeting}</Text>
      <Text style={description}>{content.description}</Text>

      <Section style={ctaSection}>
        <Button style={ctaButton} href={appDeeplink}>
          {content.cta}
        </Button>
      </Section>

      <Text style={footNote}>{content.footer}</Text>
    </Layout>
  );
};

export default WelcomeEmail;

const heading: React.CSSProperties = {
  color: "#FFFFFF",
  fontSize: "28px",
  fontWeight: 700,
  lineHeight: "36px",
  margin: "0 0 8px 0",
};

const subheading: React.CSSProperties = {
  color: "#3B82F6",
  fontSize: "20px",
  fontWeight: 600,
  lineHeight: "28px",
  margin: "0 0 16px 0",
};

const description: React.CSSProperties = {
  color: "#CCCCCC",
  fontSize: "16px",
  lineHeight: "24px",
  margin: "0 0 32px 0",
};

const ctaSection: React.CSSProperties = {
  textAlign: "center" as const,
  margin: "0 0 32px 0",
};

const ctaButton: React.CSSProperties = {
  backgroundColor: "#3B82F6",
  borderRadius: "8px",
  color: "#FFFFFF",
  fontSize: "16px",
  fontWeight: 600,
  padding: "14px 32px",
  textDecoration: "none",
};

const footNote: React.CSSProperties = {
  color: "#666666",
  fontSize: "13px",
  lineHeight: "20px",
  margin: 0,
};
