import { Text, Button, Section } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

interface WelcomeEmailProps {
  name: string;
  role: "creator" | "representative" | "listener";
  appDeeplink?: string;
}

const roleContent = {
  creator: {
    greeting: "¡Tu música merece ser escuchada!",
    description:
      "Ya puedes subir tu música, conectar con tu audiencia y hacer crecer tu carrera desde Atto.",
    cta: "Empieza a subir tu música",
  },
  representative: {
    greeting: "¡Gracias por unirte como representante!",
    description:
      "Ahora puedes conectar con tu ser querido, gestionar su perfil y ayudarle a compartir su talento con el mundo.",
    cta: "Conecta con tu ser querido",
  },
  listener: {
    greeting: "¡Bienvenido a una nueva experiencia musical!",
    description:
      "Descubre artistas únicos, escucha historias que inspiran y forma parte de una comunidad que conecta a través de la música.",
    cta: "Descubre artistas",
  },
};

export const WelcomeEmail: React.FC<WelcomeEmailProps> = ({
  name = "Usuario",
  role = "listener",
  appDeeplink = "atto://",
}) => {
  const content = roleContent[role];

  return (
    <Layout preview={`¡Bienvenido a Atto, ${name}!`}>
      <Text style={heading}>¡Hola, {name}!</Text>
      <Text style={subheading}>{content.greeting}</Text>
      <Text style={description}>{content.description}</Text>

      <Section style={ctaSection}>
        <Button style={ctaButton} href={appDeeplink}>
          {content.cta}
        </Button>
      </Section>

      <Text style={footNote}>
        Si tienes alguna pregunta, responde a este correo y te ayudaremos.
      </Text>
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
