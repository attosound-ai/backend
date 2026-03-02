defmodule ChatServiceWeb do
  @moduledoc """
  The entrypoint for defining your web interface, such
  as controllers, channels, and so on.

  This can be used in your application as:

      use ChatServiceWeb, :controller
      use ChatServiceWeb, :channel

  The definitions below will be executed for every controller,
  channel, etc, so keep them short and clean.
  """

  def static_paths, do: ~w(assets fonts images favicon.ico robots.txt)

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  def controller do
    quote do
      use Phoenix.Controller,
        formats: [:json]

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: ChatServiceWeb.Endpoint,
        router: ChatServiceWeb.Router,
        statics: ChatServiceWeb.static_paths()
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/channel/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
