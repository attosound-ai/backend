defmodule ChatServiceWeb.HealthController do
  use Phoenix.Controller, formats: [:json]

  @doc """
  GET /health
  Returns service health status.
  """
  def index(conn, _params) do
    conn
    |> put_status(200)
    |> json(%{status: "ok", service: "chat-service"})
  end
end
