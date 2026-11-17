defmodule ChatService.Telemetry.Audit do
  @moduledoc """
  Structured (JSON) audit logging + Sentry breadcrumbs for destructive chat
  operations (account-deletion cascade and orphan cleanup).

  With Cassandra at replication_factor=1 there is no safety net, so every row we
  delete is logged as a JSON line to stdout *before* the delete and recorded as a
  Sentry breadcrumb. This gives a forensic trail to reconstruct what was removed.
  """

  require Logger

  @doc "Emit a structured JSON audit log line and a Sentry breadcrumb."
  @spec log(atom(), map()) :: :ok
  def log(event, data) when is_atom(event) and is_map(data) do
    payload = data |> Map.put(:audit_event, event) |> Map.put(:service, "chat-service")
    Logger.info(encode(payload))
    breadcrumb(to_string(event), data)
    :ok
  end

  @doc "Record a Sentry breadcrumb (no-op when Sentry has no DSN configured)."
  @spec breadcrumb(String.t(), map()) :: :ok
  def breadcrumb(message, data) do
    Sentry.Context.add_breadcrumb(%{
      category: "chat.account_deletion",
      message: message,
      data: stringify(data),
      level: "info"
    })

    :ok
  rescue
    _ -> :ok
  end

  defp encode(payload) do
    case Jason.encode(payload) do
      {:ok, json} -> json
      {:error, _} -> inspect(payload)
    end
  end

  # Sentry breadcrumb data must be string-keyed and JSON-safe.
  defp stringify(map) do
    Map.new(map, fn {k, v} -> {to_string(k), safe_value(v)} end)
  end

  defp safe_value(v) when is_binary(v) or is_number(v) or is_boolean(v) or is_nil(v), do: v
  defp safe_value(v), do: inspect(v)
end
