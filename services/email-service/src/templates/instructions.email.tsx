import { Text, Section, Hr } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

interface InstructionsEmailProps {
  name: string;
  bridgeNumber?: string;
  /** BCP-47 (e.g. "en", "es", "pt-BR"). Falls back to English for any unknown value. */
  locale?: string;
}

type Locale = "en" | "es" | "pt-BR";

type Strings = {
  preview: string;
  hello: (n: string) => string;
  intro: string;
  step1Title: string;
  step1DescPrefix: string;
  step1DescPhotosCount: string;
  step1DescSuffix: string;
  step2Title: string;
  step2Desc: string;
  step3Title: string;
  step3DescPrefix: string;
  step3DescTurnaround: string;
  step3DescSuffix: string;
  step4Title: string;
  step4Desc: string;
  step4Note: string;
  footer: string;
};

const i18n: Record<Locale, Strings> = {
  en: {
    preview: "Representative instructions — Atto",
    hello: (n) => `Hi, ${n}!`,
    intro:
      "Thanks for signing up as a representative on Atto. Here are the steps to activate the profile of your artist/loved one:",
    step1Title: "Take photos",
    step1DescPrefix: "Take ",
    step1DescPhotosCount: "6-7 photographs",
    step1DescSuffix:
      " of the artist/inmate from different angles: front, left profile, right profile, three-quarter, and full body. Photos should have good lighting and a neutral background.",
    step2Title: "Send photos by postal mail",
    step2Desc: "Mail the printed photos to the following address:",
    step3Title: "Wait for processing",
    step3DescPrefix: "Turnaround is ",
    step3DescTurnaround: "1 to 3 business days",
    step3DescSuffix:
      " once the photos are received. We'll notify you when the profile is active.",
    step4Title: "Your Bridge Number",
    step4Desc: "You have been assigned the following bridge number for calls:",
    step4Note: "Use this number to make and receive calls through Atto.",
    footer:
      "Questions? Just reply to this email and we'll help you through the whole process.",
  },
  es: {
    preview: "Instrucciones para representantes — Atto",
    hello: (n) => `¡Hola, ${n}!`,
    intro:
      "Gracias por registrarte como representante en Atto. Aquí tienes los pasos para activar el perfil de tu artista/ser querido:",
    step1Title: "Tomar fotos",
    step1DescPrefix: "Toma ",
    step1DescPhotosCount: "6-7 fotografías",
    step1DescSuffix:
      " del artista/recluso desde diferentes ángulos: frontal, perfil izquierdo, perfil derecho, tres cuartos, y cuerpo completo. Las fotos deben tener buena iluminación y fondo neutro.",
    step2Title: "Enviar fotos por correo postal",
    step2Desc: "Envía las fotos impresas a la siguiente dirección:",
    step3Title: "Esperar procesamiento",
    step3DescPrefix: "El turnaround es de ",
    step3DescTurnaround: "1 a 3 días hábiles",
    step3DescSuffix:
      " una vez recibidas las fotos. Te notificaremos cuando el perfil esté activo.",
    step4Title: "Tu Bridge Number",
    step4Desc: "Se te ha asignado el siguiente número de puente para llamadas:",
    step4Note:
      "Usa este número para realizar y recibir llamadas a través de la plataforma Atto.",
    footer:
      "¿Tienes preguntas? Responde a este correo y te ayudaremos en todo el proceso.",
  },
  "pt-BR": {
    preview: "Instruções para representantes — Atto",
    hello: (n) => `Olá, ${n}!`,
    intro:
      "Obrigado por se cadastrar como representante no Atto. Aqui estão os passos para ativar o perfil do seu artista/ente querido:",
    step1Title: "Tirar fotos",
    step1DescPrefix: "Tire ",
    step1DescPhotosCount: "6-7 fotografias",
    step1DescSuffix:
      " do artista/recluso em diferentes ângulos: frontal, perfil esquerdo, perfil direito, três quartos e corpo inteiro. As fotos devem ter boa iluminação e fundo neutro.",
    step2Title: "Enviar fotos pelo correio",
    step2Desc: "Envie as fotos impressas para o seguinte endereço:",
    step3Title: "Aguardar o processamento",
    step3DescPrefix: "O prazo é de ",
    step3DescTurnaround: "1 a 3 dias úteis",
    step3DescSuffix:
      " a partir do recebimento das fotos. Avisaremos quando o perfil estiver ativo.",
    step4Title: "Seu Bridge Number",
    step4Desc: "Foi atribuído o seguinte número de ponte para chamadas:",
    step4Note:
      "Use este número para fazer e receber chamadas pela plataforma Atto.",
    footer:
      "Tem dúvidas? Responda a este e-mail e te ajudaremos em todo o processo.",
  },
};

function normalizeLocale(input?: string): Locale {
  if (!input) return "en";
  const lower = input.toLowerCase();
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("es")) return "es";
  return "en";
}

export const InstructionsEmail: React.FC<InstructionsEmailProps> = ({
  name = "Representative",
  bridgeNumber,
  locale,
}) => {
  const resolved: Locale = normalizeLocale(locale);
  const t = i18n[resolved];

  return (
    <Layout
      preview={t.preview}
      lang={resolved === "pt-BR" ? "pt" : resolved}
    >
      <Text style={heading}>{t.hello(name)}</Text>
      <Text style={subtext}>{t.intro}</Text>

      {/* Step 1 */}
      <Section style={stepSection}>
        <Text style={stepNumber}>1</Text>
        <Text style={stepTitle}>{t.step1Title}</Text>
        <Text style={stepDescription}>
          {t.step1DescPrefix}
          <strong>{t.step1DescPhotosCount}</strong>
          {t.step1DescSuffix}
        </Text>
      </Section>

      {/* Step 2 */}
      <Section style={stepSection}>
        <Text style={stepNumber}>2</Text>
        <Text style={stepTitle}>{t.step2Title}</Text>
        <Text style={stepDescription}>{t.step2Desc}</Text>
        <Section style={addressBox}>
          <Text style={addressText}>
            ATTO{"\n"}
            1245 Farmington Ave., PMB 1368{"\n"}
            West Hartford, CT 06107
          </Text>
        </Section>
      </Section>

      {/* Step 3 */}
      <Section style={stepSection}>
        <Text style={stepNumber}>3</Text>
        <Text style={stepTitle}>{t.step3Title}</Text>
        <Text style={stepDescription}>
          {t.step3DescPrefix}
          <strong>{t.step3DescTurnaround}</strong>
          {t.step3DescSuffix}
        </Text>
      </Section>

      {/* Step 4 — Bridge Number */}
      {bridgeNumber && (
        <Section style={stepSection}>
          <Text style={stepNumber}>4</Text>
          <Text style={stepTitle}>{t.step4Title}</Text>
          <Text style={stepDescription}>{t.step4Desc}</Text>
          <Section style={bridgeBox}>
            <Text style={bridgeNumberStyle}>{bridgeNumber}</Text>
          </Section>
          <Text style={stepDescription}>{t.step4Note}</Text>
        </Section>
      )}

      <Hr style={divider} />

      <Text style={footNote}>{t.footer}</Text>
    </Layout>
  );
};

export default InstructionsEmail;

const heading: React.CSSProperties = {
  color: "#FFFFFF",
  fontSize: "24px",
  fontWeight: 600,
  lineHeight: "32px",
  margin: "0 0 12px 0",
};

const subtext: React.CSSProperties = {
  color: "#CCCCCC",
  fontSize: "16px",
  lineHeight: "24px",
  margin: "0 0 32px 0",
};

const stepSection: React.CSSProperties = {
  marginBottom: "28px",
};

const stepNumber: React.CSSProperties = {
  color: "#3B82F6",
  fontSize: "14px",
  fontWeight: 700,
  backgroundColor: "#111111",
  border: "1px solid #3B82F6",
  borderRadius: "50%",
  width: "28px",
  height: "28px",
  lineHeight: "28px",
  textAlign: "center" as const,
  display: "inline-block",
  margin: "0 0 8px 0",
};

const stepTitle: React.CSSProperties = {
  color: "#FFFFFF",
  fontSize: "18px",
  fontWeight: 600,
  lineHeight: "24px",
  margin: "0 0 8px 0",
};

const stepDescription: React.CSSProperties = {
  color: "#CCCCCC",
  fontSize: "15px",
  lineHeight: "22px",
  margin: "0 0 8px 0",
};

const addressBox: React.CSSProperties = {
  backgroundColor: "#111111",
  borderRadius: "8px",
  border: "1px solid #222222",
  padding: "16px",
  margin: "8px 0 0 0",
};

const addressText: React.CSSProperties = {
  color: "#FFFFFF",
  fontSize: "15px",
  fontWeight: 500,
  lineHeight: "22px",
  margin: 0,
  whiteSpace: "pre-line",
};

const bridgeBox: React.CSSProperties = {
  backgroundColor: "#111111",
  borderRadius: "8px",
  border: "1px solid #3B82F6",
  padding: "16px",
  textAlign: "center" as const,
  margin: "8px 0 12px 0",
};

const bridgeNumberStyle: React.CSSProperties = {
  color: "#3B82F6",
  fontFamily: '"Courier New", Courier, monospace',
  fontSize: "24px",
  fontWeight: 700,
  letterSpacing: "2px",
  margin: 0,
};

const divider: React.CSSProperties = {
  borderColor: "#222222",
  margin: "32px 0 24px 0",
};

const footNote: React.CSSProperties = {
  color: "#666666",
  fontSize: "13px",
  lineHeight: "20px",
  margin: 0,
};
