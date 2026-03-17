import { Text, Section, Hr } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";

interface InstructionsEmailProps {
  name: string;
  bridgeNumber?: string;
}

export const InstructionsEmail: React.FC<InstructionsEmailProps> = ({
  name = "Representante",
  bridgeNumber,
}) => (
  <Layout preview="Instrucciones para representantes — Atto">
    <Text style={heading}>¡Hola, {name}!</Text>
    <Text style={subtext}>
      Gracias por registrarte como representante en Atto. Aquí tienes los pasos
      para activar el perfil de tu artista/ser querido:
    </Text>

    {/* Step 1 */}
    <Section style={stepSection}>
      <Text style={stepNumber}>1</Text>
      <Text style={stepTitle}>Tomar fotos</Text>
      <Text style={stepDescription}>
        Toma <strong>6-7 fotografías</strong> del artista/recluso desde
        diferentes ángulos: frontal, perfil izquierdo, perfil derecho, tres
        cuartos, y cuerpo completo. Las fotos deben tener buena iluminación y
        fondo neutro.
      </Text>
    </Section>

    {/* Step 2 */}
    <Section style={stepSection}>
      <Text style={stepNumber}>2</Text>
      <Text style={stepTitle}>Enviar fotos por correo postal</Text>
      <Text style={stepDescription}>
        Envía las fotos impresas a la siguiente dirección:
      </Text>
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
      <Text style={stepTitle}>Esperar procesamiento</Text>
      <Text style={stepDescription}>
        El turnaround es de <strong>1 a 3 días hábiles</strong> una vez
        recibidas las fotos. Te notificaremos cuando el perfil esté activo.
      </Text>
    </Section>

    {/* Step 4 — Bridge Number */}
    {bridgeNumber && (
      <Section style={stepSection}>
        <Text style={stepNumber}>4</Text>
        <Text style={stepTitle}>Tu Bridge Number</Text>
        <Text style={stepDescription}>
          Se te ha asignado el siguiente número de puente para llamadas:
        </Text>
        <Section style={bridgeBox}>
          <Text style={bridgeNumberStyle}>{bridgeNumber}</Text>
        </Section>
        <Text style={stepDescription}>
          Usa este número para realizar y recibir llamadas a través de la
          plataforma Atto.
        </Text>
      </Section>
    )}

    <Hr style={divider} />

    <Text style={footNote}>
      ¿Tienes preguntas? Responde a este correo y te ayudaremos en todo el
      proceso.
    </Text>
  </Layout>
);

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
