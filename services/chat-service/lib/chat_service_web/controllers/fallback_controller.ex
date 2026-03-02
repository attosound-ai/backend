defmodule ChatServiceWeb.FallbackController do
  @moduledoc """
  Translates controller action results into valid Plug.Conn responses.
  """
  use Phoenix.Controller

  def call(conn, {:error, :not_found}) do
    conn
    |> put_status(:not_found)
    |> put_view(ChatServiceWeb.ErrorView)
    |> render("404.json")
  end

  def call(conn, {:error, :unauthorized}) do
    conn
    |> put_status(:unauthorized)
    |> put_view(ChatServiceWeb.ErrorView)
    |> render("401.json")
  end

  def call(conn, {:error, :bad_request}) do
    conn
    |> put_status(:bad_request)
    |> put_view(ChatServiceWeb.ErrorView)
    |> render("400.json")
  end

  def call(conn, {:error, _reason}) do
    conn
    |> put_status(:internal_server_error)
    |> put_view(ChatServiceWeb.ErrorView)
    |> render("500.json")
  end
end
