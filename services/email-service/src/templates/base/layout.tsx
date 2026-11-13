import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Img,
  Text,
  Font,
  Preview,
} from "@react-email/components";
import * as React from "react";

// Same 3D logo used on the in-app welcome screen (front/assets/logo-3d.png).
// Square source (1200×1200) — served at 2× the display width for retina.
const LOGO_URL =
  "https://res.cloudinary.com/dxzcutnlp/image/upload/w_320,q_auto,f_auto/v1779560817/atto/email-logo-3d.png";

interface LayoutProps {
  preview: string;
  children: React.ReactNode;
  lang?: string;
  variant?: "dark" | "light";
}

export const Layout: React.FC<LayoutProps> = ({
  preview,
  children,
  lang = "es",
  variant = "dark",
}) => {
  const isDark = variant === "dark";

  const bodyStyle: React.CSSProperties = {
    backgroundColor: isDark ? "#000000" : "#FFFFFF",
    fontFamily: "Archivo, Arial, sans-serif",
    margin: 0,
    padding: 0,
  };

  const footerTextStyle: React.CSSProperties = {
    color: isDark ? "#666666" : "#999999",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 4px 0",
  };

  return (
    <Html lang={lang}>
      <Head>
        <Font
          fontFamily="Archivo"
          fallbackFontFamily="Arial"
          webFont={{
            url: "https://fonts.gstatic.com/s/archivo/v19/k3kPo8UDI-1M0wlSTd7iL0nAMaM.woff2",
            format: "woff2",
          }}
          fontWeight={400}
          fontStyle="normal"
        />
        {!isDark && (
          <>
            <meta name="color-scheme" content="light dark" />
            <meta name="supported-color-schemes" content="light dark" />
          </>
        )}
      </Head>
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={container}>
          <Section style={header}>
            <Img
              src={LOGO_URL}
              alt="Atto"
              width={160}
              height={160}
              style={logoImg}
            />
          </Section>

          <Section style={content}>{children}</Section>

          <Section style={footer}>
            <Text style={footerTextStyle}>
              © {new Date().getFullYear()} Atto Sound Inc.
            </Text>
            <Text style={footerTextStyle}>
              1245 Farmington Ave., PMB 1368, West Hartford, CT 06107
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

const container: React.CSSProperties = {
  maxWidth: "560px",
  margin: "0 auto",
  padding: "0",
};

const header: React.CSSProperties = {
  padding: "32px 0 0 0",
  margin: "0 0 24px 0",
  textAlign: "center" as const,
};

const logoImg: React.CSSProperties = {
  display: "block",
  width: "160px",
  height: "160px",
  margin: "0 auto",
  padding: 0,
};

const content: React.CSSProperties = {
  padding: "0 20px 32px 20px",
};

const footer: React.CSSProperties = {
  padding: "24px 20px 0 20px",
  textAlign: "center" as const,
};
