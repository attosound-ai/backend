import { Text } from "@react-email/components";
import * as React from "react";
import { Layout } from "./base/layout";
import {
  deletionEmailCopy,
  formatDeletionDate,
  type DeletionEmailKind,
} from "./account-deletion.copy";

interface AccountDeletionEmailProps {
  kind: DeletionEmailKind;
  username: string;
  /** ISO date of the final deletion (only for "scheduled"). */
  scheduledDeletionAt?: string;
  locale?: string;
}

// Borrado con 30 días de gracia: confirmación al pedirlo (con la fecha y cómo
// recuperar) y aviso al recuperar. Mismo layout claro que el de contraseña.
export const AccountDeletionEmail: React.FC<AccountDeletionEmailProps> = ({
  kind = "scheduled",
  username = "",
  scheduledDeletionAt,
  locale = "en",
}) => {
  const copy = deletionEmailCopy(
    kind,
    username,
    formatDeletionDate(scheduledDeletionAt, locale),
    locale,
  );
  return (
    <Layout preview={copy.preview} lang={locale || "en"} variant="light">
      <Text style={heading}>{copy.heading}</Text>
      {copy.paragraphs.map((p, i) => (
        <Text key={i} style={body}>
          {p}
        </Text>
      ))}
      <Text style={footnote}>{copy.footnote}</Text>
    </Layout>
  );
};

export default AccountDeletionEmail;

const heading: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: 700,
  lineHeight: "32px",
  margin: "0 0 16px 0",
};

const body: React.CSSProperties = {
  color: "#333333",
  fontSize: "16px",
  lineHeight: "24px",
  margin: "0 0 16px 0",
};

const footnote: React.CSSProperties = {
  color: "#999999",
  fontSize: "13px",
  lineHeight: "20px",
  margin: "8px 0 0 0",
};
