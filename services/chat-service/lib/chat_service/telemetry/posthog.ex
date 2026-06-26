defmodule ChatService.Telemetry.Posthog do
  @moduledoc """
  Minimal PostHog backend client.

  Emits product/lifecycle events (e.g. account-deletion cascade outcomes) to
  PostHog's `/capture/` endpoint so backend behaviour is traceable in the same
  PostHog project the mobile app already uses.

  No-ops when no `:api_key` is configured (dev/test), so call sites never need to
  guard on configuration. Events are sent fire-and-forget in a Task — telemetry
  must never block or crash the caller.
  """

  require Logger

  @doc """
  Capture a PostHog event.

    * `event` — event name, e.g. `"backend_account_chat_deleted"`
    * `distinct_id` — usually the affected user id
    * `properties` — extra map (atoms or strings), JSON-encodable
  """
  @spec capture(String.t(), term(), map()) :: :ok
  def capture(event, distinct_id, properties \\ %{}) do
    case config() do
      %{api_key: key, host: host} when is_binary(key) and key != "" ->
        body = %{
          api_key: key,
          event: event,
          distinct_id: to_string(distinct_id),
          properties: Map.put(properties, :"$lib", "chat-service")
        }

        Task.start(fn -> do_send(host, body, event) end)
        :ok

      _ ->
        :ok
    end
  end

  defp do_send(host, body, event) do
    url = String.trim_trailing(host, "/") <> "/capture/"
    headers = [{"content-type", "application/json"}]

    with {:ok, json} <- Jason.encode(body),
         {:ok, status, _headers, _ref} when status in 200..299 <-
           :hackney.request(:post, url, headers, json, [:with_body, recv_timeout: 5_000]) do
      :ok
    else
      other ->
        Logger.warning("PostHog capture failed for #{event}: #{inspect(other)}")
        :error
    end
  end

  defp config, do: Application.get_env(:chat_service, __MODULE__, %{}) |> Map.new()
end
