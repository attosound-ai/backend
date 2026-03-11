/// Predefined transformation presets for different media contexts.
/// Open/Closed: new presets are added here without modifying CloudinaryClient.
pub struct TransformationPresets;

impl TransformationPresets {
    /// Avatar: face-detection crop, multiple sizes eager-generated.
    pub fn avatar_eager() -> String {
        [
            "c_thumb,g_face,w_40,h_40,f_auto,q_auto",
            "c_thumb,g_face,w_80,h_80,f_auto,q_auto",
            "c_thumb,g_face,w_200,h_200,f_auto,q_auto",
        ]
        .join("|")
    }

    /// Content image: responsive sizes for feed display.
    pub fn content_image_eager() -> String {
        [
            "c_limit,w_300,f_auto,q_auto",
            "c_limit,w_750,f_auto,q_auto",
            "c_limit,w_1500,f_auto,q_auto",
        ]
        .join("|")
    }

    /// Audio: no visual transformations needed.
    pub fn audio_eager() -> Option<String> {
        None
    }

    /// Chat image: optimized smaller sizes for inline display.
    pub fn chat_image_eager() -> String {
        [
            "c_limit,w_400,f_auto,q_auto",
            "c_limit,w_800,f_auto,q_auto",
        ]
        .join("|")
    }

    /// Video: generate a thumbnail from the first frame.
    pub fn video_thumbnail_eager() -> String {
        "c_limit,w_750,h_750,f_jpg,q_auto/jpg".to_string()
    }

    /// Reel (vertical video): generate a vertical thumbnail.
    pub fn reel_thumbnail_eager() -> String {
        "c_limit,w_480,h_854,f_jpg,q_auto/jpg".to_string()
    }
}
