use eframe::egui::IconData;

const ICON_SIZE: usize = 64;
const BLUE: [u8; 4] = [42, 171, 238, 255];
const BLUE_DARK: [u8; 4] = [25, 121, 181, 255];
const WHITE: [u8; 4] = [255, 255, 255, 255];
const TRANSPARENT: [u8; 4] = [0, 0, 0, 0];

pub fn messk_icon() -> IconData {
    let mut rgba = vec![0; ICON_SIZE * ICON_SIZE * 4];
    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let pixel = if in_rounded_square(x, y, 7, 13) {
                if y > 42 { BLUE_DARK } else { BLUE }
            } else {
                TRANSPARENT
            };
            write_pixel(&mut rgba, x, y, pixel);
        }
    }

    for y in 18..42 {
        for x in 16..49 {
            if in_rounded_rect(x, y, 16, 18, 49, 42, 8) {
                write_pixel(&mut rgba, x, y, WHITE);
            }
        }
    }
    for y in 36..49 {
        for x in 37..51 {
            if x + y <= 87 {
                write_pixel(&mut rgba, x, y, WHITE);
            }
        }
    }
    for y in 26..30 {
        for x in 24..42 {
            write_pixel(&mut rgba, x, y, BLUE_DARK);
        }
    }
    for y in 34..38 {
        for x in 24..36 {
            write_pixel(&mut rgba, x, y, BLUE_DARK);
        }
    }

    IconData {
        rgba,
        width: ICON_SIZE as u32,
        height: ICON_SIZE as u32,
    }
}

fn write_pixel(rgba: &mut [u8], x: usize, y: usize, pixel: [u8; 4]) {
    let index = (y * ICON_SIZE + x) * 4;
    rgba[index..index + 4].copy_from_slice(&pixel);
}

fn in_rounded_square(x: usize, y: usize, inset: usize, radius: usize) -> bool {
    in_rounded_rect(
        x,
        y,
        inset,
        inset,
        ICON_SIZE - inset,
        ICON_SIZE - inset,
        radius,
    )
}

fn in_rounded_rect(
    x: usize,
    y: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    radius: usize,
) -> bool {
    if x < left || x >= right || y < top || y >= bottom {
        return false;
    }
    let inner_left = left + radius;
    let inner_right = right.saturating_sub(radius + 1);
    let inner_top = top + radius;
    let inner_bottom = bottom.saturating_sub(radius + 1);
    if (inner_left..=inner_right).contains(&x) || (inner_top..=inner_bottom).contains(&y) {
        return true;
    }
    let cx = if x < inner_left {
        inner_left
    } else {
        inner_right
    };
    let cy = if y < inner_top {
        inner_top
    } else {
        inner_bottom
    };
    let dx = x.abs_diff(cx);
    let dy = y.abs_diff(cy);
    dx * dx + dy * dy <= radius * radius
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_has_expected_size_and_alpha() {
        let icon = messk_icon();
        assert_eq!(icon.width, ICON_SIZE as u32);
        assert_eq!(icon.height, ICON_SIZE as u32);
        assert_eq!(icon.rgba.len(), ICON_SIZE * ICON_SIZE * 4);
        assert_eq!(&icon.rgba[3..4], &[0]);
        let center_alpha = icon.rgba[((32 * ICON_SIZE + 32) * 4) + 3];
        assert_eq!(center_alpha, 255);
    }
}
