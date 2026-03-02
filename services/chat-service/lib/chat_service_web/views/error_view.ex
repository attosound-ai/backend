defmodule ChatServiceWeb.ErrorView do
  use Phoenix.Component

  def render("400.json", _assigns) do
    %{success: false, data: nil, error: "Bad request"}
  end

  def render("401.json", _assigns) do
    %{success: false, data: nil, error: "Unauthorized"}
  end

  def render("403.json", _assigns) do
    %{success: false, data: nil, error: "Forbidden"}
  end

  def render("404.json", _assigns) do
    %{success: false, data: nil, error: "Not found"}
  end

  def render("500.json", _assigns) do
    %{success: false, data: nil, error: "Internal server error"}
  end

  # By default, Phoenix returns the status message from the template name.
  def render(template, _assigns) do
    %{
      success: false,
      data: nil,
      error: Phoenix.Controller.status_message_from_template(template)
    }
  end
end
