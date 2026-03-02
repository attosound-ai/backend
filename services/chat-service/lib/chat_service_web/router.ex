defmodule ChatServiceWeb.Router do
  use Phoenix.Router

  import Plug.Conn
  import Phoenix.Controller

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :authenticated do
    plug ChatServiceWeb.Plugs.RequireUserId
  end

  scope "/api/v1", ChatServiceWeb do
    pipe_through [:api, :authenticated]

    get "/messages/conversations", ConversationController, :index
    post "/messages/conversations", ConversationController, :create
    get "/messages/:chat_id", MessageController, :index
    post "/messages", MessageController, :create
  end

  scope "/", ChatServiceWeb do
    get "/health", HealthController, :index
  end

  # Enable LiveDashboard in development
  if Application.compile_env(:chat_service, :dev_routes, false) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through [:fetch_session, :protect_from_forgery]
      live_dashboard "/dashboard", metrics: ChatServiceWeb.Telemetry
    end
  end
end
